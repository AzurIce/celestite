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
        let mut doc = Buffer::new(
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
        let _ = doc
            .apply(BufferCommand::Import(Import::new(
                packet.unwrap(),
                "filesystem",
            )))
            .unwrap();
        assert_eq!(doc.snapshot().text, after);
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
        None,
        "A middle B",
    )
    .unwrap();
    let disk = doc.version();
    let writer = doc.writer_id();
    let _ = doc
        .apply(BufferCommand::Edit(Edit {
            base: disk.clone(),
            input: TextInput::Edits {
                edits: vec![TextEdit {
                    from: 2,
                    to: 8,
                    insert: "MIDDLE".into(),
                }],
            },
            origin: "local".into(),
            group: None,
            undo: UndoContext {
                metadata: None,
                positions: vec![],
            },
        }))
        .unwrap();
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
    let update = doc
        .apply(BufferCommand::Import(Import::new(
            packet.unwrap(),
            "filesystem",
        )))
        .unwrap();
    assert_eq!(update.after, doc.version());
    assert!(update.local_operation().is_none());
    assert_eq!(doc.snapshot().text, "A1 MIDDLE B1");
    assert_eq!(doc.historical_text(&external).unwrap(), "A1 middle B1");
    assert_eq!(doc.writer_id(), writer);
    assert_eq!(doc.resolve_anchor(&anchor).unwrap().offset, 6);
    let _ = doc
        .apply(BufferCommand::Undo {
            base: doc.version(),
            context: UndoContext::default(),
        })
        .unwrap();
    assert_eq!(doc.snapshot().text, "A1 middle B1");
}

#[test]
fn unknown_or_inconsistent_disk_versions_are_rejected() {
    let doc = Buffer::new(
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
