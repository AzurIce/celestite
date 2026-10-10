use celestite_buffer::{
    Buffer,
    positions::ToOffset,
    types::{
        Anchor, BufferError, BufferUpdate, ChangeCause, DocumentIdentity, EditOptions,
        HistoryPacket, HistoryPacketKind, ImportOptions, TextEdit, UndoContext, Version,
    },
};
use std::ops::Range;

fn identity() -> DocumentIdentity {
    DocumentIdentity {
        document_id: "notes/draft".into(),
        history_id: "history".into(),
    }
}
fn buffer(peer_id: u64, text: &str) -> Buffer {
    Buffer::with_peer_id(identity(), peer_id, text).unwrap()
}
fn replica(source: &Buffer, peer_id: u64) -> Buffer {
    Buffer::from_snapshot_with_peer_id(&source.export_snapshot().unwrap(), peer_id).unwrap()
}

/// Every accepted receipt must replay exactly, using BEFORE-text byte ranges.
fn accept(
    b: &mut Buffer,
    mutate: impl FnOnce(&mut Buffer) -> Result<BufferUpdate, BufferError>,
) -> BufferUpdate {
    let before = b.snapshot();
    let update = mutate(b).unwrap();
    assert_eq!(update.before, before.version);
    assert_eq!(update.after, b.version());
    assert_eq!(update.before_len, before.text.len());
    assert_eq!(update.after_len, b.len());
    let mut replay = before.text.to_string();
    for edit in update.edits.iter().rev() {
        replay.replace_range(edit.from..edit.to, &edit.insert);
    }
    assert_eq!(replay, b.text());
    update
}
fn edit(
    b: &mut Buffer,
    edits: impl IntoIterator<Item = (Range<usize>, &'static str)>,
) -> BufferUpdate {
    accept(b, |b| b.edit(edits))
}
fn grouped(
    b: &mut Buffer,
    edits: impl IntoIterator<Item = (Range<usize>, &'static str)>,
    group: &str,
) -> BufferUpdate {
    accept(b, |b| {
        b.edit_with(
            edits,
            EditOptions {
                group: Some(group.into()),
                ..Default::default()
            },
        )
    })
}
fn import(b: &mut Buffer, packet: HistoryPacket) -> BufferUpdate {
    accept(b, |b| b.import(packet))
}
fn undo(b: &mut Buffer) -> BufferUpdate {
    accept(b, Buffer::undo)
}
fn redo(b: &mut Buffer) -> BufferUpdate {
    accept(b, Buffer::redo)
}
fn sync(from: &Buffer, to: &mut Buffer) -> BufferUpdate {
    import(to, from.export_updates_since(&to.version()).unwrap())
}

fn tagged(tag: u64, group: Option<&str>) -> EditOptions {
    EditOptions {
        group: group.map(Into::into),
        undo: UndoContext {
            tag: Some(tag),
            positions: vec![],
        },
    }
}

#[test]
fn default_peers_native_reads_and_scalar_boundaries() {
    let mut b = Buffer::new(identity(), "A😀é中").unwrap();
    let peer = Buffer::from_snapshot(&b.export_snapshot().unwrap()).unwrap();
    assert_ne!(b.peer_id(), peer.peer_id());
    assert_eq!(b.identity(), &identity());
    assert_eq!(b.len(), 11);
    assert!(!b.is_empty());
    assert!(b.content_matches("A😀é中"));
    assert!(!b.content_matches("A😀é文"));
    assert_eq!(b.slice(1..5).unwrap(), "😀");
    assert_eq!(b.slice(6..8).unwrap(), "́");
    for offset in [2, 3, 4, 7, 9, 10, 13, usize::MAX] {
        assert!(offset.to_offset(&b).is_err());
        assert!(b.slice(offset..offset).is_err());
    }
    let position = 5usize;
    assert_eq!(ToOffset::to_offset(&&position, &b).unwrap(), 5);
    let anchor = b.anchor_after(position).unwrap();
    let end = b.anchor_before(6).unwrap();
    let update = accept(&mut b, |b| b.edit([(&anchor..&end, "E")]));
    assert_eq!(
        update.edits,
        vec![TextEdit {
            from: 5,
            to: 6,
            insert: "E".into()
        }]
    );
    assert_eq!(b.text(), "A😀É中");
}

#[test]
fn a_mutation_returns_exact_local_peer_operations_and_owned_effects() {
    let mut local = buffer(u64::MAX - 1, "A😀B");
    let mut peer = replica(&local, 2);
    let first = edit(&mut local, [(1..1, "中")]);
    assert!(first.changed);
    assert_eq!(first.cause, ChangeCause::Local);
    assert!(local.undo_state().can_undo);
    let first_version = first.after.clone();
    let second = edit(&mut local, [(0..0, "second ")]);
    let _ = import(&mut peer, first.local_operation().unwrap().clone());
    assert_eq!(peer.text(), "A中😀B");
    assert_eq!(peer.version(), first_version);
    let received = import(&mut peer, second.local_operation().unwrap().clone());
    assert!(received.local_operation().is_none());
    assert_eq!(peer.text(), local.text());
    assert_eq!(
        Version::decode(identity(), &local.version().encode().unwrap()).unwrap(),
        local.version()
    );
    assert!(local.version().clock(u64::MAX - 1) > 0);
    assert_eq!(local.version().clock(123), 0);
    assert_eq!(local.version().iter().count(), 1);

    // An imported peer's history must not leak into a subsequent local packet.
    let remote = edit(&mut peer, [(0..0, "remote ")]);
    let _ = import(&mut local, remote.operation.unwrap());
    let receipt = edit(&mut local, [(0..0, "last ")]);
    let doc =
        loro::LoroDoc::decode_import_blob_meta(&receipt.operation.unwrap().data, true).unwrap();
    assert_eq!(doc.partial_start_vv.iter().count(), 1);
    assert_eq!(doc.partial_end_vv.iter().count(), 1);
    assert!(doc.partial_end_vv.get(&(u64::MAX - 1)).is_some());
}

#[test]
// The range is an invalid transaction input, not an iterator.
#[allow(clippy::reversed_empty_ranges)]
fn rejected_and_noop_edits_do_not_change_text_history_or_grouping() {
    let mut b = buffer(1, "😀");
    let _ = grouped(&mut b, [(0..0, "A")], "gesture");
    let before = b.snapshot();
    let history = b.undo_state();
    for (scenario, edits) in [
        (
            "split scalar after valid edit",
            vec![(0..0, "bad"), (2..2, "split scalar")],
        ),
        ("reversed range", vec![(5..1, "bad")]),
        (
            "insertion overlaps replacement",
            vec![(0..1, "x"), (0..0, "y")],
        ),
        ("overlapping ranges", vec![(0..3, "x"), (2..5, "overlap")]),
        ("outside text", vec![(6..6, "outside")]),
    ] {
        assert!(b.edit(edits).is_err(), "{scenario}");
        assert_eq!(b.snapshot(), before, "{scenario}");
        assert_eq!(b.undo_state(), history, "{scenario}");
    }
    let foreign = Buffer::new(
        DocumentIdentity {
            history_id: "different".into(),
            ..identity()
        },
        "wrong",
    )
    .unwrap();
    let anchor = foreign.anchor_after(0).unwrap();
    assert!(matches!(
        b.edit([(&anchor..&anchor, "")]),
        Err(BufferError::IdentityMismatch)
    ));
    let noop = edit(&mut b, [(0..1, "A")]);
    assert!(!noop.changed);
    assert!(noop.operation.is_none());
    assert_eq!(b.snapshot(), before);
    assert!(!accept(&mut b, |b| b.replace_text("A😀")).changed);
    let _ = grouped(&mut b, [(5..5, "B")], "gesture");
    let _ = undo(&mut b);
    assert_eq!(b.text(), "😀");
}

#[test]
fn snapshots_are_owned_and_clones_share_the_retained_text() {
    let mut local = buffer(1, "base");
    let original = local.snapshot();
    let retained = original.clone();
    assert!(std::sync::Arc::ptr_eq(&original.text, &retained.text));
    let _ = edit(&mut local, [(0..0, "local ")]);
    assert_eq!(local.text(), "local base");
    assert_eq!(original.text.as_ref(), "base");
    assert_eq!(retained.text.as_ref(), "base");
}

#[test]
fn collaborative_undo_preserves_remote_text_and_restores_opaque_tags() {
    let mut a = buffer(1, "");
    let _ = accept(&mut a, |a| {
        a.edit_with(
            [(0..0, "abc")],
            EditOptions {
                undo: UndoContext {
                    tag: Some(u64::MAX),
                    positions: vec![],
                },
                ..Default::default()
            },
        )
    });
    let mut b = replica(&a, 2);
    assert!(!b.undo_state().can_undo);
    let _ = edit(&mut b, [(1..1, "中😀")]);
    let _ = sync(&b, &mut a);
    let undone = accept(&mut a, |a| {
        a.undo_with(UndoContext {
            tag: Some(0),
            positions: vec![],
        })
    });
    assert_eq!(a.text(), "中😀");
    assert_eq!(undone.restored.unwrap().tag, Some(u64::MAX));
    let redone = redo(&mut a);
    assert_eq!(a.text(), "a中😀bc");
    assert_eq!(redone.restored.unwrap().tag, Some(0));
    let _ = sync(&a, &mut b);
    assert_eq!(a.version(), b.version());
}

#[test]
fn undo_positions_transform_replaced_ranges_and_absolute_end_cursors() {
    let mut a = buffer(1, "Hello world.");
    let _ = accept(&mut a, |a| {
        a.edit_with(
            [(6..11, "*world*")],
            EditOptions {
                undo: UndoContext {
                    tag: Some(1),
                    positions: vec![6, 11, 0, 5],
                },
                ..Default::default()
            },
        )
    });
    let mut b = replica(&a, 2);
    let _ = edit(&mut b, [(0..0, "远🧠")]);
    let _ = sync(&b, &mut a);
    let update = accept(&mut a, |a| {
        a.undo_with(UndoContext {
            tag: None,
            positions: vec![13, 20, 7, 12],
        })
    });
    assert_eq!(a.text(), "远🧠Hello world.");
    assert_eq!(update.restored.unwrap().positions, vec![13, 18, 0, 12]);
    assert_eq!(
        redo(&mut a).restored.unwrap().positions,
        vec![13, 20, 7, 12]
    );
    let before = a.snapshot();
    assert!(
        a.edit_with(
            [(0..0, "bad")],
            EditOptions {
                undo: UndoContext {
                    positions: vec![2],
                    ..Default::default()
                },
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        a.undo_with(UndoContext {
            positions: vec![4],
            ..Default::default()
        })
        .is_err()
    );
    assert_eq!(a.snapshot(), before);

    let mut end = buffer(10, "hello");
    let _ = accept(&mut end, |b| {
        b.edit_with(
            [(0..1, "H")],
            EditOptions {
                undo: UndoContext {
                    positions: vec![5],
                    ..Default::default()
                },
                ..Default::default()
            },
        )
    });
    let mut remote = replica(&end, 11);
    let _ = edit(&mut remote, [(5..5, "🧠")]);
    let _ = sync(&remote, &mut end);
    assert_eq!(undo(&mut end).restored.unwrap().positions, vec![9]);
}

#[test]
fn personal_only_undo_and_history_clear_are_explicit_updates() {
    let mut a = buffer(1, "");
    assert!(!undo(&mut a).changed);
    assert!(!redo(&mut a).changed);
    let _ = edit(&mut a, [(0..0, "local")]);
    let mut b = replica(&a, 2);
    let _ = edit(&mut b, [(0..5, "")]);
    let _ = sync(&b, &mut a);
    let update = undo(&mut a);
    assert!(update.changed);
    assert!(update.edits.is_empty());
    assert!(!a.undo_state().can_undo);
    let _ = edit(&mut a, [(0..0, "next")]);
    let cleared = accept(&mut a, Buffer::clear_undo);
    assert!(cleared.changed);
    assert!(cleared.operation.is_none());
    assert_eq!(cleared.cause, ChangeCause::HistoryCleared);
    assert_eq!(cleared.before, cleared.after);
    assert!(!accept(&mut a, Buffer::clear_undo).changed);
}

#[test]
fn group_ids_merge_only_consecutive_local_edits_and_imports_break_the_group() {
    let mut a = buffer(1, "");
    let _ = grouped(&mut a, [(0..0, "n")], "ime");
    let _ = grouped(&mut a, [(0..1, "你")], "ime");
    let _ = grouped(&mut a, [(3..3, "好")], "ime");
    let _ = undo(&mut a);
    assert_eq!(a.text(), "");
    let _ = redo(&mut a);
    let mut b = replica(&a, 2);
    let _ = grouped(&mut a, [(6..6, "A")], "next");
    let _ = edit(&mut b, [(0..0, "远")]);
    let _ = sync(&b, &mut a);
    let _ = grouped(&mut a, [(10..10, "B")], "next");
    let _ = undo(&mut a);
    assert_eq!(a.text(), "远你好A");
    let _ = undo(&mut a);
    assert_eq!(a.text(), "远你好");
}

#[test]
fn anchors_keep_affinity_through_deletion_and_checkpoint_transfer() {
    let mut a = buffer(1, "a😀b");
    let mut b = replica(&a, 2);
    let before = a.anchor_before(5).unwrap();
    let after = a.anchor_after(5).unwrap();
    let start = a.anchor_before(0).unwrap();
    let end = a.anchor_after(6).unwrap();
    assert!(a.anchor_after(2).is_err());
    let _ = edit(&mut b, [(5..5, "中")]);
    let _ = sync(&b, &mut a);
    assert_eq!(before.to_offset(&a).unwrap(), 5);
    assert_eq!(after.to_offset(&a).unwrap(), 8);
    let _ = edit(&mut a, [(0..0, "前"), (9..9, "后")]);
    assert_eq!(start.to_offset(&a).unwrap(), 0);
    assert_eq!(end.to_offset(&a).unwrap(), 15);
    let _ = edit(&mut a, [(4..12, "")]);
    assert_eq!(a.text(), "前a后");
    assert_eq!(before.to_offset(&a).unwrap(), 4);
    let recovered = replica(&a, 3);
    let encoded: Anchor = serde_json::from_str(&serde_json::to_string(&after).unwrap()).unwrap();
    assert_eq!(encoded.to_offset(&recovered).unwrap(), 4);
    let foreign = Buffer::new(
        DocumentIdentity {
            history_id: "other".into(),
            ..identity()
        },
        "same",
    )
    .unwrap();
    assert!(matches!(
        encoded.to_offset(&foreign),
        Err(BufferError::IdentityMismatch)
    ));
    let mut empty = buffer(10, "");
    let left = empty.anchor_before(0).unwrap();
    let right = empty.anchor_after(0).unwrap();
    let _ = edit(&mut empty, [(0..0, "🧠")]);
    assert_eq!(left.to_offset(&empty).unwrap(), 0);
    assert_eq!(right.to_offset(&empty).unwrap(), 4);
}

#[test]
fn whole_text_replacement_uses_native_byte_deltas_and_personal_undo() {
    let mut b = buffer(1, "A😀B");
    let update = accept(&mut b, |b| b.replace_text("A中B"));
    assert_eq!(
        update.edits,
        vec![TextEdit {
            from: 1,
            to: 5,
            insert: "中".into()
        }]
    );
    assert_eq!(b.text(), "A中B");
    let _ = undo(&mut b);
    assert_eq!(b.text(), "A😀B");
    let _ = redo(&mut b);
    assert_eq!(b.text(), "A中B");
}

#[test]
fn pending_imports_are_journalable_and_duplicate_packets_are_noops() {
    let mut a = buffer(1, "");
    let mut b = replica(&a, 2);
    let first = edit(&mut a, [(0..0, "A")]).operation.unwrap();
    let second = edit(&mut a, [(1..1, "中😀")]).operation.unwrap();
    let pending = import(&mut b, second.clone());
    assert!(b.has_pending_imports() && pending.changed);
    assert!(pending.edits.is_empty());
    assert_eq!(pending.operation.as_ref().unwrap().data, second.data);
    assert!(pending.local_operation().is_none());
    let before = b.snapshot();
    assert!(!import(&mut b, second).changed);
    assert_eq!(b.snapshot(), before);
    let _ = import(&mut b, first.clone());
    assert!(!b.has_pending_imports());
    assert_eq!(b.text(), "A中😀");
    assert_eq!(b.version(), a.version());
    assert!(!import(&mut b, first).changed);
    assert!(!b.undo_state().can_undo);
}

#[test]
fn preparation_replays_pending_history_and_preserves_the_original_replica() {
    let base = buffer(1, "base");
    let mut sender = replica(&base, 2);
    let mut receiver = replica(&base, 3);
    let _ = edit(&mut receiver, [(0..0, "local ")]);
    let first = edit(&mut sender, [(4..4, "1")]).operation.unwrap();
    let second = edit(&mut sender, [(5..5, "2")]).operation.unwrap();
    let stale = receiver.prepare_import(first.clone()).unwrap();
    let version = receiver.version();
    let _ = import(&mut receiver, second);
    assert_eq!(receiver.version(), version);
    assert!(matches!(
        receiver.commit_import(stale),
        Err(BufferError::StalePreparation)
    ));
    let before = receiver.snapshot();
    let history = receiver.undo_state();
    let peer_id = receiver.peer_id();
    let prepared = receiver.prepare_import(first.clone()).unwrap();
    assert_eq!(prepared.before(), &before.version);
    assert_eq!(prepared.packet().data, first.data);
    assert!(prepared.accepts_operations());
    assert_eq!(prepared.preview().text, "local base12");
    assert!(!prepared.preview().pending);
    let expected = prepared.preview().version.clone();
    assert_eq!(receiver.snapshot(), before);
    assert_eq!(receiver.undo_state(), history);
    let update = accept(&mut receiver, |b| b.commit_import(prepared));
    assert_eq!(update.after, expected);
    assert!(!receiver.has_pending_imports());
    assert_eq!(receiver.peer_id(), peer_id);
    let _ = undo(&mut receiver);
    assert_eq!(receiver.text(), "base12");
}

#[test]
fn preparations_are_bound_to_one_unchanged_owner_even_when_versions_match() {
    let mut base = buffer(1, "base");
    let mut a = replica(&base, 2);
    let mut b = replica(&base, 3);
    let packet = edit(&mut base, [(4..4, "new")]).operation.unwrap();
    let foreign = a.prepare_import(packet.clone()).unwrap();
    let before = b.snapshot();
    assert!(matches!(
        b.commit_import(foreign),
        Err(BufferError::StalePreparation)
    ));
    assert_eq!(b.snapshot(), before);
    let stale = a.prepare_import(packet.clone()).unwrap();
    let _ = edit(&mut a, [(0..0, "local ")]);
    assert!(matches!(
        a.commit_import(stale),
        Err(BufferError::StalePreparation)
    ));
    let stale = a.prepare_import(packet.clone()).unwrap();
    let version = a.version();
    let _ = accept(&mut a, Buffer::clear_undo);
    assert_eq!(a.version(), version);
    assert!(matches!(
        a.commit_import(stale),
        Err(BufferError::StalePreparation)
    ));
    let stable = a.prepare_import(packet).unwrap();
    let _ = edit(&mut a, []);
    let _ = accept(&mut a, |a| a.commit_import(stable));
    let foreign = HistoryPacket {
        identity: DocumentIdentity {
            history_id: "other".into(),
            ..identity()
        },
        ..base.export_snapshot().unwrap()
    };
    assert!(matches!(
        a.prepare_import(foreign),
        Err(BufferError::IdentityMismatch)
    ));
}

#[test]
fn explicit_import_reset_clears_undo_without_changing_peer_id_or_history() {
    let mut local = buffer(1, "base");
    let mut peer = replica(&local, 2);
    let _ = edit(&mut local, [(0..0, "draft ")]);
    let packet = edit(&mut peer, [(4..4, " disk")]).operation.unwrap();
    let peer_id = local.peer_id();
    let update = accept(&mut local, |b| {
        b.import_with(packet, ImportOptions { reset_undo: true })
    });
    assert_eq!(local.text(), "draft base disk");
    assert_eq!(local.peer_id(), peer_id);
    assert!(!local.undo_state().can_undo);
    assert!(update.local_operation().is_none());

    // Reset with a duplicate packet still changes personal state atomically.
    let _ = edit(&mut local, [(0..0, "new ")]);
    let prepared = local
        .prepare_import_with(
            local.export_snapshot().unwrap(),
            ImportOptions { reset_undo: true },
        )
        .unwrap();
    assert!(!prepared.accepts_operations());
    let update = accept(&mut local, |b| b.commit_import(prepared));
    assert!(update.changed);
    assert_eq!(update.before, update.after);
    assert!(update.operation.is_none());
    assert!(!local.undo_state().can_undo);
}

#[test]
fn identities_peer_id_collisions_corruption_and_packet_modes_reject_atomically() {
    let a = buffer(1, "base");
    let mut peer = replica(&a, 2);
    let packet = edit(&mut peer, [(0..0, "peer ")]).operation.unwrap();
    let before = a.snapshot();
    for packet in [
        HistoryPacket {
            identity: DocumentIdentity {
                document_id: "other".into(),
                ..identity()
            },
            ..packet.clone()
        },
        HistoryPacket {
            kind: HistoryPacketKind::Snapshot,
            ..packet.clone()
        },
        HistoryPacket {
            data: vec![1, 2, 3].into(),
            ..packet.clone()
        },
    ] {
        assert!(a.prepare_import(packet).is_err());
        assert_eq!(a.snapshot(), before);
    }
    assert!(matches!(
        Buffer::from_snapshot_with_peer_id(&a.export_snapshot().unwrap(), 1),
        Err(BufferError::PeerIdAlreadyUsed { .. })
    ));
    let foreign = loro::LoroDoc::from_snapshot(&a.export_snapshot().unwrap().data).unwrap();
    foreign.set_peer_id(1).unwrap();
    let start = foreign.oplog_vv();
    foreign.get_text("source").insert(0, "forged").unwrap();
    foreign.commit();
    let forged = HistoryPacket::from_binary(
        identity(),
        foreign.export(loro::ExportMode::updates(&start)).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        a.prepare_import(forged),
        Err(BufferError::PeerIdCollision)
    ));
    assert_eq!(a.snapshot(), before);
    let external = loro::LoroDoc::new();
    external.get_text("source").insert(0, "text").unwrap();
    external.commit();
    let shallow = HistoryPacket {
        identity: identity(),
        kind: HistoryPacketKind::Snapshot,
        data: external
            .export(loro::ExportMode::shallow_snapshot(
                &external.state_frontiers(),
            ))
            .unwrap()
            .into(),
    };
    assert!(matches!(
        Buffer::from_snapshot(&shallow),
        Err(BufferError::UnsupportedHistory)
    ));
    external.get_map("view").insert("cursor", 1).unwrap();
    external.commit();
    let invalid = HistoryPacket::from_binary(
        identity(),
        external.export(loro::ExportMode::Snapshot).unwrap(),
    )
    .unwrap();
    assert!(Buffer::from_snapshot(&invalid).is_err());
}

#[test]
fn versions_are_history_scoped_and_unavailable_history_is_rejected() {
    let b = buffer(1, "base");
    let mut vector = loro::VersionVector::default();
    vector.insert(1, b.version().clock(1) + 1);
    let future = Version::decode(identity(), &vector.encode()).unwrap();
    assert!(!b.version().contains(&future));
    let foreign = Version::decode(
        DocumentIdentity {
            history_id: "other".into(),
            ..identity()
        },
        &b.version().encode().unwrap(),
    )
    .unwrap();
    assert!(!b.version().contains(&foreign));
    assert!(matches!(
        b.export_updates_since(&foreign),
        Err(BufferError::IdentityMismatch)
    ));
    assert!(Version::decode(identity(), &[0xff]).is_err());
    assert!(b.version().contains(&b.version()));
}

#[test]
fn pending_imports_cannot_bypass_source_only_schema_validation() {
    let base = buffer(1, "base");
    let mut receiver = replica(&base, 2);
    let foreign = loro::LoroDoc::from_snapshot(&base.export_snapshot().unwrap().data).unwrap();
    foreign.set_peer_id(3).unwrap();
    let start = foreign.oplog_vv();
    foreign.get_text("source").insert(0, "prefix ").unwrap();
    foreign.commit();
    let first = HistoryPacket::from_binary(
        identity(),
        foreign.export(loro::ExportMode::updates(&start)).unwrap(),
    )
    .unwrap();
    let middle = foreign.oplog_vv();
    foreign.get_map("view").insert("cursor", 42).unwrap();
    foreign.commit();
    let last = HistoryPacket::from_binary(
        identity(),
        foreign.export(loro::ExportMode::updates(&middle)).unwrap(),
    )
    .unwrap();
    let before = receiver.snapshot();
    match receiver.import(last) {
        Err(BufferError::InvalidPacket) => {}
        Ok(_) => {
            assert!(receiver.has_pending_imports());
            assert!(matches!(
                receiver.prepare_import(first),
                Err(BufferError::InvalidPacket)
            ));
        }
        Err(error) => panic!("unexpected error: {error}"),
    }
    assert_eq!(receiver.text(), before.text.as_ref());
    assert_eq!(receiver.version(), before.version);
}

#[test]
fn undo_tags_follow_loro_pruning_grouping_redo_and_queued_receipt_ownership() {
    let mut b = buffer(1, "");
    for tag in 1..=501 {
        let end = b.len();
        let _ = b.edit_with([(end..end, "x")], tagged(tag, None)).unwrap();
    }
    let tags = b.undo_tags();
    assert_eq!(tags, (2..=501).collect::<Vec<_>>());
    // A popped frame is no longer in the undo stack. Its receipt must retain it
    // for an external adapter even after both Loro stacks are cleared.
    let receipt = b
        .undo_with(UndoContext {
            tag: Some(900),
            positions: vec![],
        })
        .unwrap();
    assert_eq!(receipt.restored.as_ref().unwrap().tag, Some(501));
    assert!(b.undo_tags().contains(&501));
    assert!(b.undo_tags().contains(&900));
    let queued_clone = receipt.clone();
    let _ = b.clear_undo().unwrap();
    assert_eq!(b.undo_tags(), vec![501]);
    drop(receipt);
    assert_eq!(b.undo_tags(), vec![501]);
    drop(queued_clone);
    assert!(b.undo_tags().is_empty());

    // Only metadata actually retained by the Loro group remains live.
    for (tag, insert) in [(10, "a"), (11, "b")] {
        let _ = b
            .edit_with([(0..0, insert)], tagged(tag, Some("gesture")))
            .unwrap();
    }
    assert_eq!(b.undo_tags(), vec![10]);
    let receipt = b
        .undo_with(UndoContext {
            tag: Some(20),
            positions: vec![],
        })
        .unwrap();
    assert_eq!(receipt.restored.as_ref().unwrap().tag, Some(10));
    drop(receipt);
    assert_eq!(b.undo_tags(), vec![20]);
    let receipt = b.redo().unwrap();
    assert_eq!(receipt.restored.as_ref().unwrap().tag, Some(20));
    let _ = b.clear_undo().unwrap();
    assert_eq!(b.undo_tags(), vec![20]);
    drop(receipt);
    assert!(b.undo_tags().is_empty());

    // Reusing a tag in separate undo entries must not lose the older frame when
    // the latest frame is popped and its receipt dropped.
    for insert in ["a", "b"] {
        let _ = b.edit_with([(0..0, insert)], tagged(7, None)).unwrap();
    }
    drop(b.undo().unwrap());
    assert_eq!(b.undo_tags(), vec![7]);
    drop(b.undo().unwrap());
    assert!(b.undo_tags().is_empty());
}
