use super::*;

#[test]
fn real_distributed_rewrites_complete_and_preserve_the_exact_disk_branch() {
    for (name, before, after) in [
        (
            "notation",
            include_str!("../../tests/fixtures/filesystem/notation.before.txt"),
            include_str!("../../tests/fixtures/filesystem/notation.after.txt"),
        ),
        (
            "builtin",
            include_str!("../../tests/fixtures/filesystem/builtin.before.txt"),
            include_str!("../../tests/fixtures/filesystem/builtin.after.txt"),
        ),
        (
            "content-functions",
            include_str!("../../tests/fixtures/filesystem/content-functions.before.txt"),
            include_str!("../../tests/fixtures/filesystem/content-functions.after.txt"),
        ),
    ] {
        let mut doc = Document::new(
            DocumentIdentity {
                document_id: name.into(),
                history_id: "history".into(),
            },
            None,
            before,
        )
        .unwrap();
        let live = doc.snapshot();
        let started = std::time::Instant::now();
        let (packet, version) = doc
            .prepare_filesystem_change(&live.version, before)
            .unwrap()
            .compute(after, filesystem::DIFF_BUDGET)
            .unwrap();
        eprintln!("{name}: {:.2} ms", started.elapsed().as_secs_f64() * 1000.);
        assert_eq!(doc.snapshot(), live);
        doc.import(&packet, "filesystem".into()).unwrap();
        assert_eq!(doc.snapshot().text, after);
        assert_eq!(doc.historical_text(&version).unwrap(), after);
    }
}

#[test]
fn historical_diff_does_not_mutate_live_undo_anchors_or_subscribers() {
    let mut doc = Document::new(
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: "history".into(),
        },
        None,
        "A middle B",
    )
    .unwrap();
    let disk = doc.version();
    let writer = doc.writer_id();
    let subscription = doc.subscribe();
    doc.transact(Transaction {
        expected_version: disk.clone(),
        origin: "local".into(),
        edits: vec![TextEdit {
            from: 2,
            to: 8,
            insert: "MIDDLE".into(),
        }],
        undo_metadata: None,
        undo_positions: vec![],
    })
    .unwrap();
    subscription.recv().unwrap();
    let anchor = doc.anchor_at(5, Affinity::After).unwrap();
    let before = doc.snapshot();
    let undo = doc.undo_state();
    let (packet, external) = doc
        .prepare_filesystem_change(&disk, "A middle B")
        .unwrap()
        .compute("A1 middle B1", filesystem::DIFF_BUDGET)
        .unwrap();
    assert_eq!(doc.snapshot(), before);
    assert_eq!(doc.undo_state(), undo);
    assert!(matches!(
        subscription.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    doc.import(&packet, "filesystem".into()).unwrap();
    let event = subscription.recv().unwrap();
    assert_eq!(event.after.text, "A1 MIDDLE B1");
    assert_eq!(doc.historical_text(&external).unwrap(), "A1 middle B1");
    assert_eq!(doc.writer_id(), writer);
    assert_eq!(doc.resolve_anchor(&anchor).unwrap().offset, 6);
    doc.undo(None).unwrap();
    assert_eq!(subscription.recv().unwrap().after.text, "A1 middle B1");
}

#[test]
fn unknown_or_inconsistent_disk_versions_are_rejected() {
    let doc = Document::new(
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: "history".into(),
        },
        None,
        "base",
    )
    .unwrap();
    let mut future = doc.version();
    *future.clocks.values_mut().next().unwrap() += 1;
    assert!(doc.historical_text(&future).is_err());
    assert!(
        doc.prepare_filesystem_change(&doc.version(), "wrong")
            .is_err()
    );
    future = doc.version();
    future.identity.history_id = "another history".into();
    assert!(matches!(
        doc.historical_text(&future),
        Err(CoreError::IdentityMismatch)
    ));
}
