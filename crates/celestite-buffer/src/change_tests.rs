use crate::{
    Buffer,
    types::{Affinity, BufferError, DocumentIdentity, Version},
};
use std::time::Duration;

#[test]
fn timed_out_change_preserves_live_state_and_accepts_no_operations() {
    let mut doc = Buffer::new(
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: "history".into(),
        },
        "before",
    )
    .unwrap();
    let _ = doc.edit([(0..0, "local ")]).unwrap();
    let before = doc.snapshot();
    let peer_id = doc.peer_id();
    let undo = doc.undo_state();
    let anchor = doc.anchor_after(1).unwrap();
    let result = doc
        .prepare_text_change(&before.version, &before.text)
        .unwrap()
        .compute("after", Duration::ZERO);
    assert!(matches!(result, Err(BufferError::DiffTimeout)));
    assert_eq!(doc.snapshot(), before);
    assert_eq!(doc.peer_id(), peer_id);
    assert_eq!(doc.undo_state(), undo);
    assert_eq!(anchor.to_offset(&doc).unwrap(), 1);
}

#[test]
fn real_distributed_rewrites_complete_and_preserve_the_exact_disk_branch() {
    for (name, before, after) in [
        (
            "notation",
            include_str!("../tests/fixtures/filesystem/notation.before.txt"),
            include_str!("../tests/fixtures/filesystem/notation.after.txt"),
        ),
        (
            "builtin",
            include_str!("../tests/fixtures/filesystem/builtin.before.txt"),
            include_str!("../tests/fixtures/filesystem/builtin.after.txt"),
        ),
        (
            "content-functions",
            include_str!("../tests/fixtures/filesystem/content-functions.before.txt"),
            include_str!("../tests/fixtures/filesystem/content-functions.after.txt"),
        ),
    ] {
        let mut doc = Buffer::new(
            DocumentIdentity {
                document_id: name.into(),
                history_id: "history".into(),
            },
            before,
        )
        .unwrap();
        let live = doc.snapshot();
        let started = std::time::Instant::now();
        let (packet, version) = doc
            .prepare_text_change(&live.version, before)
            .unwrap()
            .compute(after, Duration::from_secs(5))
            .unwrap();
        eprintln!("{name}: {:.2} ms", started.elapsed().as_secs_f64() * 1000.);
        assert_eq!(doc.snapshot(), live);
        let _ = doc.import(packet.unwrap()).unwrap();
        assert_eq!(doc.text(), after);
        assert_eq!(doc.historical_text(&version).unwrap(), after);
    }
}

#[test]
fn historical_diff_does_not_mutate_the_live_buffer_or_personal_history() {
    let mut doc = Buffer::new(
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: "history".into(),
        },
        "A middle B",
    )
    .unwrap();
    let disk = doc.version();
    let peer_id = doc.peer_id();
    let _ = doc.edit([(2..8, "MIDDLE")]).unwrap();
    let anchor = doc.anchor_at(5, Affinity::After).unwrap();
    let before = doc.snapshot();
    let undo = doc.undo_state();
    let (packet, external) = doc
        .prepare_text_change(&disk, "A middle B")
        .unwrap()
        .compute("A1 middle B1", Duration::from_secs(5))
        .unwrap();
    assert_eq!(doc.snapshot(), before);
    assert_eq!(doc.undo_state(), undo);
    let update = doc.import(packet.unwrap()).unwrap();
    assert_eq!(update.after, doc.version());
    assert!(update.local_operation().is_none());
    assert_eq!(doc.text(), "A1 MIDDLE B1");
    assert_eq!(doc.historical_text(&external).unwrap(), "A1 middle B1");
    assert_eq!(doc.peer_id(), peer_id);
    assert_eq!(anchor.to_offset(&doc).unwrap(), 6);
    let _ = doc.undo().unwrap();
    assert_eq!(doc.text(), "A1 middle B1");
}

#[test]
fn unknown_or_inconsistent_disk_versions_are_rejected() {
    let doc = Buffer::new(
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: "history".into(),
        },
        "base",
    )
    .unwrap();
    let mut vector = doc.version().vector().clone();
    vector.insert(doc.peer_id(), doc.version().clock(doc.peer_id()) + 1);
    let future = Version::from_vector(doc.identity().clone(), vector).unwrap();
    assert!(doc.historical_text(&future).is_err());
    assert!(doc.prepare_text_change(&doc.version(), "wrong").is_err());
    let mut identity = doc.identity().clone();
    identity.history_id = "another history".into();
    let future = Version::from_vector(identity, doc.version().vector().clone()).unwrap();
    assert!(matches!(
        doc.historical_text(&future),
        Err(BufferError::IdentityMismatch)
    ));
}
