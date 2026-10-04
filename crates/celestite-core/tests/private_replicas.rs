use celestite_core::*;
use futures_lite::future::block_on;
use serde_json::json;

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
        let seed = Document::new(
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
                "replace_text",
                json!({"id":"file","version":base,"text":text}),
            )
            .await
            .unwrap();
        }
        let a_packet = a.updates("file", &base).unwrap();
        let b_packet = b.updates("file", &base).unwrap();
        a.import("file", b_packet.clone()).await.unwrap();
        b.import("file", a_packet.clone()).await.unwrap();
        c.import("file", b_packet.clone()).await.unwrap();
        c.import("file", a_packet).await.unwrap();
        c.import("file", b_packet).await.unwrap();
        let merged = a.read("file").unwrap().snapshot;
        assert_eq!(merged.text, b.read("file").unwrap().snapshot.text);
        assert_eq!(merged.version, c.read("file").unwrap().snapshot.version);
        assert!(merged.text.contains('a') && merged.text.contains('b'));
        a.undo("file", UndoContext::default(), false).await.unwrap();
        let undo = a.updates("file", &merged.version).unwrap();
        b.import("file", undo.clone()).await.unwrap();
        c.import("file", undo).await.unwrap();
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
        let packet = Document::new(
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
            "replace_text",
            json!({"id":"file","version":before,"text":"draft"}),
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
                "replace_text",
                json!({"id":"file","version":before,"text":"stale"})
            )
            .await
            .is_err()
        );
        assert_eq!(core.read("file").unwrap().snapshot.text, "draft");
    });
}

#[test]
fn host_receipts_and_discard_keep_replica_versions_and_other_personal_undo() {
    block_on(async {
        let packet = Document::new(
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
        let other = Document::new(
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
                "replace_text",
                json!({"id":id,"version":version,"text":text}),
            )
            .await
            .unwrap();
        }
        let state = ReplicaHostState {
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
        assert_eq!(
            core.reset_replica("other.md", packet.clone())
                .await
                .unwrap_err()
                .code,
            "Conflict"
        );
        assert_eq!(core.read("file").unwrap().snapshot.text, "draft");
        core.reset_replica("a.md", packet).await.unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text, "seed");
        assert!(!core.read("file").unwrap().undo.can_undo);
        assert_eq!(core.read("other").unwrap().snapshot.text, "keep other edit");
        assert!(core.read("other").unwrap().undo.can_undo);
        let mut read_only = state;
        read_only.version = core.read("file").unwrap().snapshot.version;
        read_only.read_only = true;
        core.apply_host_state("file", read_only).await.unwrap();
        assert_eq!(core.execute_service("replace_text", json!({"id":"file","version":core.read("file").unwrap().snapshot.version,"text":"blocked"})).await.unwrap_err().code,
            "PermissionDenied");
        core.subscribe_preview("file", "readonly-view").unwrap();
        assert!(core.take_preview_task("file").unwrap().is_some());
    });
}
