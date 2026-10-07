use celestite_core::*;
use futures_lite::future::block_on;
use serde_json::json;

fn seed(id: &str, text: &str) -> SyncPacket {
    Buffer::new(
        DocumentIdentity {
            document_id: id.into(),
            history_id: format!("history-{id}"),
        },
        None,
        text,
    )
    .unwrap()
    .export_snapshot()
    .unwrap()
}
fn hosted(packet: SyncPacket, path: &str, deleted: bool) -> ReplicaDocument {
    let snapshot = Buffer::from_snapshot(&packet, None).unwrap().snapshot();
    ReplicaDocument {
        packets: vec![packet],
        writer_id: None,
        state: ReplicaHostState {
            path: path.into(),
            version: snapshot.version,
            saved_content: snapshot.text,
            backend_revision: "disk".into(),
            bom: false,
            line_ending: "\n".into(),
            deleted,
            read_only: false,
            conflict: false,
            error: None,
            external_change: None,
        },
    }
}

#[test]
fn deleted_and_recreated_paths_join_in_either_order() {
    block_on(async {
        for reverse in [false, true] {
            let mut core = replica("client", seed("base", "base")).await;
            let mut inputs = vec![
                hosted(seed("old", "old"), "same.md", true),
                hosted(seed("new", "new"), "same.md", false),
            ];
            if reverse {
                inputs.reverse();
            }
            core.replace_replica_session(inputs).await.unwrap();
            assert!(core.read("old").unwrap().deleted);
            assert_eq!(core.read("new").unwrap().snapshot.text, "new");
            assert!(core.read("base").unwrap().deleted);
        }
        let mut core = replica("client", seed("base", "base")).await;
        core.join_replica_document(hosted(seed("new", "new"), "same.md", false))
            .await
            .unwrap();
        core.join_replica_document(hosted(seed("old", "old"), "same.md", true))
            .await
            .unwrap();
        assert!(core.read("old").unwrap().deleted);
    });
}

#[test]
fn reconnect_validates_final_paths_and_rejects_whole_invalid_sessions() {
    block_on(async {
        let a = seed("A", "A");
        let b = seed("B", "B");
        let mut core = replica("client", a.clone()).await;
        core.join("b.md", b.clone()).await.unwrap();
        let version = core.read("A").unwrap().snapshot.version;
        core.execute_service(
            "apply",
            json!({"id":"A","command":{"kind":"edit","base":version,"input":{"kind":"text","text":"retained draft"}}}),
        )
        .await
        .unwrap();
        let original = core.read("A").unwrap();
        let subscription = core.subscribe_preview("A", "view").unwrap();
        let mut invalid = hosted(b.clone(), "a.md", false);
        invalid.state.version.clocks.insert("unseen".into(), 1);
        assert!(
            core.replace_replica_session(vec![hosted(a.clone(), "c.md", false), invalid])
                .await
                .is_err()
        );
        let retained = core.read("A").unwrap();
        assert_eq!(original.snapshot.version, retained.snapshot.version);
        assert_eq!(original.writer_id, retained.writer_id);
        assert!(retained.undo.can_undo);
        assert_eq!(retained.path, "a.md");
        // B precedes A, while B's new path was owned by A in the old session.
        core.replace_replica_session(vec![hosted(b, "a.md", false), hosted(a, "c.md", false)])
            .await
            .unwrap();
        assert_eq!(core.read("A").unwrap().path, "c.md");
        assert_eq!(core.read("B").unwrap().path, "a.md");
        assert!(!core.read("A").unwrap().undo.can_undo);
        assert_eq!(core.preview_state("A").unwrap().target.path, "c.md");
        core.retry_preview("A").unwrap();
        assert!(core.take_preview_task("A").unwrap().is_some());
        assert!(core.unsubscribe_preview(&subscription.subscription_id, "view"));
    });
}

#[test]
fn session_imports_catch_up_packets_and_close_does_not_require_write_permission() {
    block_on(async {
        let initial = seed("file", "seed");
        let mut source = Buffer::from_snapshot(&initial, None).unwrap();
        let before = source.version();
        let _ = source
            .apply(BufferCommand::Edit(Edit {
                base: before.clone(),
                input: TextInput::Edits {
                    edits: vec![TextEdit {
                        from: 0,
                        to: 0,
                        insert: "remote ".into(),
                    }],
                },
                origin: "test".into(),
                group: None,
                undo: UndoContext {
                    metadata: None,
                    positions: vec![],
                },
            }))
            .unwrap();
        let mut input = hosted(source.export_snapshot().unwrap(), "a.md", false);
        input.packets = vec![
            initial.clone(),
            source.export_updates_since(&before).unwrap(),
        ];
        input.state.read_only = true;
        let mut core = replica("client", initial).await;
        core.replace_replica_session(vec![input]).await.unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text, "remote seed");
        let before = source.version();
        let _ = source
            .apply(BufferCommand::Edit(Edit {
                base: before.clone(),
                input: TextInput::Edits {
                    edits: vec![TextEdit {
                        from: 0,
                        to: 0,
                        insert: "next ".into(),
                    }],
                },
                origin: "test".into(),
                group: None,
                undo: UndoContext {
                    metadata: None,
                    positions: vec![],
                },
            }))
            .unwrap();
        core.apply(
            "file",
            BufferCommand::Import(Import::new(
                source.export_updates_since(&before).unwrap(),
                "peer",
            )),
        )
        .await
        .unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text, "next remote seed");
        assert_eq!(core.execute_service("apply", json!({"id":"file","command":{"kind":"edit","base":core.read("file").unwrap().snapshot.version,"input":{"kind":"text","text":"blocked"}}})).await.unwrap_err().code, "PermissionDenied");
        core.execute_service("close", json!({})).await.unwrap();
    });
}

async fn replica(name: &str, packet: SyncPacket) -> EditorCore<MemoryBackend> {
    let mut core = EditorCore::open(MemoryBackend::new(
        InstanceIdentity {
            instance_id: name.into(),
            vault: Vault {
                vault_id: "vault".into(),
                history_id: "vault-history".into(),
            },
        },
        || 1000,
    ))
    .await
    .unwrap();
    core.join("a.md", packet).await.unwrap();
    core
}
#[test]
fn three_private_cores_merge_concurrent_edits_and_keep_personal_undo() {
    block_on(async {
        let seed = Buffer::new(
            DocumentIdentity {
                document_id: "file".into(),
                history_id: "history".into(),
            },
            Some(100),
            "A😀B",
        )
        .unwrap()
        .export_snapshot()
        .unwrap();
        let mut a = replica("a", seed.clone()).await;
        let mut b = replica("b", seed.clone()).await;
        let mut c = replica("c", seed).await;
        let base = a.read("file").unwrap().snapshot.version;
        assert_ne!(
            a.read("file").unwrap().writer_id,
            b.read("file").unwrap().writer_id
        );
        for (core, text) in [(&mut a, "A😀aB"), (&mut b, "A😀bB")] {
            core.execute_service(
                "apply",
                json!({"id":"file","command":{"kind":"edit","base":base,"input":{"kind":"text","text":text}}}),
            )
            .await
            .unwrap();
        }
        let a_packet = a.updates("file", &base).unwrap();
        let b_packet = b.updates("file", &base).unwrap();
        a.apply(
            "file",
            BufferCommand::Import(Import::new(b_packet.clone(), "peer")),
        )
        .await
        .unwrap();
        b.apply(
            "file",
            BufferCommand::Import(Import::new(a_packet.clone(), "peer")),
        )
        .await
        .unwrap();
        c.apply(
            "file",
            BufferCommand::Import(Import::new(b_packet.clone(), "peer")),
        )
        .await
        .unwrap();
        c.apply("file", BufferCommand::Import(Import::new(a_packet, "peer")))
            .await
            .unwrap();
        c.apply("file", BufferCommand::Import(Import::new(b_packet, "peer")))
            .await
            .unwrap();
        let merged = a.read("file").unwrap().snapshot;
        assert_eq!(merged.text, b.read("file").unwrap().snapshot.text);
        assert_eq!(merged.version, c.read("file").unwrap().snapshot.version);
        assert!(merged.text.contains('a') && merged.text.contains('b'));
        a.apply(
            "file",
            BufferCommand::Undo {
                base: a.read("file").unwrap().snapshot.version,
                context: UndoContext::default(),
            },
        )
        .await
        .unwrap();
        let undo = a.updates("file", &merged.version).unwrap();
        b.apply(
            "file",
            BufferCommand::Import(Import::new(undo.clone(), "peer")),
        )
        .await
        .unwrap();
        c.apply("file", BufferCommand::Import(Import::new(undo, "peer")))
            .await
            .unwrap();
        for core in [&a, &b, &c] {
            let state = core.read("file").unwrap();
            assert_eq!(state.snapshot.text, "A😀bB");
            assert!(state.durable_version.is_none());
            assert!(state.saved_version.is_none());
            assert!(state.autosave_delay.is_none());
        }
        assert!(b.read("file").unwrap().undo.can_undo);
    });
}
#[test]
fn joining_a_known_history_does_not_reseed_or_alias_another_identity() {
    block_on(async {
        let packet = Buffer::new(
            DocumentIdentity {
                document_id: "file".into(),
                history_id: "history".into(),
            },
            None,
            "seed",
        )
        .unwrap()
        .export_snapshot()
        .unwrap();
        let mut core = replica("client", packet.clone()).await;
        let before = core.read("file").unwrap().snapshot.version;
        core.execute_service(
            "apply",
            json!({"id":"file","command":{"kind":"edit","base":before,"input":{"kind":"text","text":"draft"}}}),
        )
        .await
        .unwrap();
        core.join("a.md", packet.clone()).await.unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text, "draft");
        assert!(core.join("../a.md", packet.clone()).await.is_err());
        assert!(core.join("b.md", packet.clone()).await.is_err());
        let mut other = packet.clone();
        other.identity.history_id = "different".into();
        assert_eq!(core.join("a.md", other).await.unwrap_err().code, "Conflict");
        assert!(
            core.execute_service(
                "apply",
                json!({"id":"file","command":{"kind":"edit","base":before,"input":{"kind":"text","text":"stale"}}})
            )
            .await
            .is_err()
        );
        assert_eq!(core.read("file").unwrap().snapshot.text, "draft");
    });
}

#[test]
fn host_receipts_and_session_replacement_keep_history_and_clear_personal_undo() {
    block_on(async {
        let packet = Buffer::new(
            DocumentIdentity {
                document_id: "file".into(),
                history_id: "history".into(),
            },
            None,
            "seed",
        )
        .unwrap()
        .export_snapshot()
        .unwrap();
        let mut core = replica("client", packet.clone()).await;
        let other = Buffer::new(
            DocumentIdentity {
                document_id: "other".into(),
                history_id: "other-history".into(),
            },
            None,
            "other",
        )
        .unwrap()
        .export_snapshot()
        .unwrap();
        core.join("other.md", other).await.unwrap();
        for (id, text) in [("file", "draft"), ("other", "keep other edit")] {
            let version = core.read(id).unwrap().snapshot.version;
            core.execute_service(
                "apply",
                json!({"id":id,"command":{"kind":"edit","base":version,"input":{"kind":"text","text":text}}}),
            )
            .await
            .unwrap();
        }
        let state = ReplicaHostState {
            external_change: None,
            path: "a.md".into(),
            version: core.read("file").unwrap().snapshot.version,
            saved_content: "seed".into(),
            backend_revision: "remote-1".into(),
            bom: false,
            line_ending: "\n".into(),
            deleted: false,
            conflict: false,
            error: None,
            read_only: false,
        };
        core.apply_host_state("file", state.clone()).await.unwrap();
        assert!(core.read("file").unwrap().autosave_delay.is_some());
        assert!(core.read("file").unwrap().durable_version.is_none());
        let mut unseen = state.clone();
        unseen.version.clocks.insert("unseen".into(), 1);
        assert!(core.apply_host_state("file", unseen).await.is_err());
        assert_eq!(core.read("file").unwrap().backend_revision, "remote-1");
        let collision = hosted(packet.clone(), "other.md", false);
        let other_packet = core.snapshot("other").unwrap();
        assert_eq!(
            core.replace_replica_session(vec![
                collision,
                hosted(other_packet.clone(), "other.md", false),
            ])
            .await
            .unwrap_err()
            .code,
            "Conflict"
        );
        assert_eq!(core.read("file").unwrap().snapshot.text, "draft");
        core.replace_replica_session(vec![
            hosted(packet, "a.md", false),
            hosted(other_packet, "other.md", false),
        ])
        .await
        .unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text, "seed");
        assert!(!core.read("file").unwrap().undo.can_undo);
        assert_eq!(core.read("other").unwrap().snapshot.text, "keep other edit");
        assert!(!core.read("other").unwrap().undo.can_undo);
        let mut read_only = state;
        read_only.version = core.read("file").unwrap().snapshot.version;
        read_only.read_only = true;
        core.apply_host_state("file", read_only).await.unwrap();
        assert_eq!(core.execute_service("apply", json!({"id":"file","command":{"kind":"edit","base":core.read("file").unwrap().snapshot.version,"input":{"kind":"text","text":"blocked"}}})).await.unwrap_err().code,
            "PermissionDenied");
        core.subscribe_preview("file", "readonly-view").unwrap();
        assert!(core.take_preview_task("file").unwrap().is_some());
    });
}
