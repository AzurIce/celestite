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
