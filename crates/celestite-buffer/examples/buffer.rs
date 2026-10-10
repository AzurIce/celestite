//! Native Buffer walkthrough: `cargo run -p celestite-buffer --example buffer`.
//! The owner handles display patches, persistence and transmission explicitly.

use celestite_buffer::{
    Buffer,
    types::{BufferError, BufferUpdate, DocumentIdentity, EditOptions, HistoryPacket, UndoContext},
};

fn main() -> Result<(), BufferError> {
    println!("1. Create a history with a generated peer ID and edit directly");
    let identity = DocumentIdentity {
        document_id: "walkthrough".into(),
        history_id: "walkthrough-history-1".into(),
    };
    let mut alice = Buffer::new(identity.clone(), "A😀B")?;
    let initial = alice.snapshot();
    assert_eq!(initial.text.as_ref(), "A😀B");
    assert_eq!(alice.identity(), &identity);
    assert_eq!(alice.len(), 6); // A: 0..1, 😀: 1..5, B: 5..6 in UTF-8 bytes.
    assert_eq!(alice.slice(1..5)?, "😀");
    let update = alice.edit([(5..5, "!")])?;
    show_update(&update);
    assert_eq!(alice.text(), "A😀!B");
    assert!(update.after.contains(&initial.version));

    println!("\n2. Retain stable anchors rather than stale numeric positions");
    let before = alice.anchor_before(5)?;
    let after = alice.anchor_after(5)?;
    let update = alice.edit([(&before..&after, "?")])?;
    show_update(&update);
    assert_eq!(alice.text(), "A😀?!B");
    assert_eq!(before.to_offset(&alice)?, 5);
    assert_eq!(after.to_offset(&alice)?, 6);
    assert_eq!(after.to_offset(&alice)?, 6); // No refreshed-anchor return.
    let current = alice.snapshot();
    assert!(alice.edit([(2..2, "inside emoji")]).is_err());
    assert_eq!(alice.snapshot(), current);
    let noop = alice.replace_text(&current.text)?;
    assert!(!noop.changed);
    assert!(noop.operation.is_none());

    println!("\n3. Optional gesture grouping and opaque caller-owned context tags");
    let _ = alice.clear_undo()?;
    assert!(!alice.undo_state().can_undo);
    let selection = UndoContext {
        tag: Some(42),
        positions: vec![5],
    };
    // A host can associate 42 with its own view/selection metadata outside Buffer.
    // Whole-text replacement uses the same validated native edit pipeline.
    for (text, position) in [("A😀?!B?", 5), ("A😀?!B??", 8)] {
        let _ = alice.replace_text_with(
            text,
            EditOptions {
                group: Some("typing-gesture-1".into()),
                undo: UndoContext {
                    tag: selection.tag,
                    positions: vec![position],
                },
            },
        )?;
    }
    let undo = alice.undo_with(UndoContext {
        tag: Some(43),
        positions: vec![8],
    })?;
    show_update(&undo);
    assert_eq!(alice.text(), current.text.as_ref());
    assert_eq!(undo.restored, Some(selection));
    assert!(!alice.undo_state().can_undo);
    assert!(alice.undo_state().can_redo);
    let redo = alice.redo()?;
    assert_eq!(redo.restored.as_ref().unwrap().tag, Some(43));
    assert!(redo.local_operation().is_some());
    assert_eq!(alice.text(), "A😀?!B??");

    println!("\n4. Join the same history and exchange concurrent operations");
    // Join from a history snapshot, never construct another history from its text.
    // Explicit with_peer_id/from_snapshot_with_peer_id are optional when the host
    // can guarantee peer ID uniqueness; generated peer IDs are the simple default.
    let seed = round_trip(&alice.export_snapshot()?)?;
    let mut bob = Buffer::from_snapshot(&seed)?;
    assert_ne!(bob.peer_id(), alice.peer_id());
    assert_eq!(bob.version(), alice.version());
    assert!(!bob.undo_state().can_undo);
    let shared = alice.version();
    let alice_edit = alice.edit([(0..0, "Hello ")])?;
    let bob_edit = bob.edit([(bob.len()..bob.len(), " from Bob")])?;
    // Forward the exact command packet, not display patches or regenerated history.
    let alice_packet = round_trip(alice_edit.local_operation().unwrap())?;
    let bob_packet = round_trip(bob_edit.local_operation().unwrap())?;
    let imported = bob.import(alice_packet)?;
    assert!(imported.local_operation().is_none()); // Never echo an import upstream.
    let imported = alice.import(bob_packet)?;
    show_update(&imported);
    assert!(!alice.has_pending_imports());
    assert_eq!(alice.text(), "Hello A😀?!B?? from Bob");
    assert_eq!(alice.text(), bob.text());
    assert_eq!(alice.version(), bob.version());

    println!("\n5. Preview an import, enforce owner policy, then commit once");
    let mut carol = Buffer::from_snapshot(&seed)?;
    let catch_up = alice.export_updates_since(&shared)?;
    let before_import = carol.snapshot();
    let prepared = carol.prepare_import(catch_up.clone())?;
    assert_eq!(prepared.before(), &before_import.version);
    assert_eq!(prepared.preview().text, alice.text());
    assert!(!prepared.preview().pending);
    assert!(prepared.accepts_operations());
    assert_eq!(prepared.packet().data, catch_up.data);
    assert_eq!(carol.snapshot(), before_import);
    // PreparedImport is single-use and tied to this unchanged Buffer, including
    // personal undo and accepted pending history, not only the visible version.
    let update = carol.commit_import(prepared)?;
    show_update(&update);
    assert_eq!(carol.version(), alice.version());
    assert_eq!(carol.text(), alice.text());
    let duplicate = carol.import(catch_up)?;
    assert!(!duplicate.changed);
    assert!(duplicate.operation.is_none());
    assert_eq!(initial.text.as_ref(), "A😀B"); // Immutable snapshot remains valid.
    println!("\nWalkthrough complete: all assertions passed.");
    Ok(())
}

fn round_trip(packet: &HistoryPacket) -> Result<HistoryPacket, BufferError> {
    HistoryPacket::from_binary(packet.identity.clone(), packet.data.to_vec())
}

fn show_update(update: &BufferUpdate) {
    // Display patches are BEFORE-text byte ranges, not synchronization operations.
    println!(
        "   {:?}: changed={}, byte length {} -> {}",
        update.cause, update.changed, update.before_len, update.after_len
    );
    println!("   display edits: {:?}", update.edits);
    println!(
        "   history packet: {} bytes",
        update.operation.as_ref().map_or(0, |p| p.data.len())
    );
    // Query undo_state()/has_pending_imports() from the owner at acceptance.
}
