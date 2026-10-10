use celestite_buffer::Buffer;
use celestite_buffer::types::{DocumentIdentity, EditOptions, UndoContext, Version};
use celestite_core::backend::memory::MemoryBackend;
use celestite_core::editor::EditorCore;
use celestite_core::instance::{InstanceIdentity, Vault};
use celestite_core::preview::sessions::PreviewController;
use celestite_core::preview::{PreviewCompletion, PreviewOutcome, PreviewOutput};
use celestite_core::protocol::editor::EditorAdapter;
use futures_lite::future::block_on;
use serde_json::{Value, json};

async fn replica(text: &str) -> EditorCore<MemoryBackend> {
    let mut core = EditorCore::open(MemoryBackend::new(
        InstanceIdentity {
            instance_id: "protocol-client".into(),
            vault: Vault {
                vault_id: "vault".into(),
                history_id: "vault-history".into(),
            },
        },
        || 1000,
    ))
    .await
    .unwrap();
    let buffer = Buffer::with_peer_id(
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: "history".into(),
        },
        u64::MAX - 1, // Loro reserves MAX internally; this still exceeds JS precision.
        text,
    )
    .unwrap();
    core.join("a.md", buffer.export_snapshot().unwrap())
        .await
        .unwrap();
    core
}

#[test]
fn stale_wire_base_is_rejected_without_text_history_undo_or_preview_effects() {
    block_on(async {
        let mut core = replica("A😀甲").await;
        let mut adapter = EditorAdapter::default();
        let base = core.read("doc").unwrap().snapshot.version;
        core.replace_text("doc", "A😀甲!").await.unwrap();
        core.take_mutations();
        let mut controller = PreviewController::default();
        controller.synchronize(&core.document_source(&[]), 1000);
        controller.subscribe("doc", "client", 1000).unwrap();
        let ids = controller.required_snapshots("doc").unwrap();
        let task = controller
            .take_task("doc", &core.document_source(&ids), 1000)
            .unwrap()
            .unwrap();
        let before = core.read("doc").unwrap();
        let preview = serde_json::to_value(controller.state("doc").unwrap()).unwrap();
        let packet = core.snapshot("doc").unwrap();
        // Native invalid UTF-8 boundaries have no accepted or derived effects either.
        assert!(core.edit("doc", [(2..2, "invalid")]).await.is_err());
        controller.synchronize(&core.document_source(&[]), 1000);
        assert_eq!(core.read("doc").unwrap().snapshot, before.snapshot);
        assert_eq!(core.read("doc").unwrap().undo, before.undo);
        assert!(core.take_mutations().is_empty());
        assert_eq!(
            serde_json::to_value(controller.state("doc").unwrap()).unwrap(),
            preview
        );
        for command in [
            json!({"kind":"edit","base":base,"input":{"kind":"text","text":"stale"},"group":"stale","undo":{"metadata":{"stale":true},"positions":[0]}}),
            json!({"kind":"undo","base":base,"context":{"metadata":{"stale":true},"positions":[0]}}),
            json!({"kind":"redo","base":base,"context":{"positions":[0]}}),
        ] {
            let error = adapter
                .call(&mut core, "apply", json!({"id":"doc","command":command}))
                .await
                .unwrap_err();
            assert_eq!(error.code, "StaleVersion");
            let after = core.read("doc").unwrap();
            assert_eq!(after.snapshot, before.snapshot);
            assert_eq!(after.undo, before.undo);
            assert_eq!(after.peer_id, before.peer_id);
            assert_eq!(after.persisted_version, before.persisted_version);
            assert_eq!(core.snapshot("doc").unwrap().data, packet.data);
            assert!(adapter.take_mutations(&mut core).unwrap().is_empty());
            controller.synchronize(&core.document_source(&[]), 1000);
            assert_eq!(
                serde_json::to_value(controller.state("doc").unwrap()).unwrap(),
                preview
            );
        }
        controller.synchronize(&core.document_source(&[]), 1000);
        assert!(controller.complete(PreviewCompletion {
            task_id: task.ticket.task_id,
            outcome: PreviewOutcome::Success {
                output: PreviewOutput {
                    html: "still current".into(),
                    diagnostics: vec![],
                    source_map: vec![],
                    used_components: vec![],
                },
            },
        }));
    });
}

#[test]
fn wire_edit_and_undo_map_utf16_edits_lengths_and_metadata() {
    block_on(async {
        // UTF-16 boundaries: A=0..1, 😀=1..3, 甲=3..4, é=4..5.
        // UTF-8 boundaries:  A=0..1, 😀=1..5, 甲=5..8, é=8..10.
        let mut core = replica("A😀甲é").await;
        let mut adapter = EditorAdapter::default();
        let base = core.read("doc").unwrap().snapshot.version;
        let metadata = json!({"mainIndex":1,"selection":"甲é"});
        adapter
            .call(
                &mut core,
                "apply",
                json!({"id":"doc","command":{
                    "kind":"edit","base":base,
                    "input":{"kind":"edits","edits":[{"from":3,"to":5,"insert":"界🚀"}]},
                    "undo":{"metadata":metadata,"positions":[3,5]},"group":"gesture"
                }}),
            )
            .await
            .unwrap();
        let edited = core.read("doc").unwrap();
        assert_eq!(edited.snapshot.text.as_ref(), "A😀界🚀");
        let batch = adapter.take_mutations(&mut core).unwrap();
        assert_eq!(batch.len(), 1);
        let update = &batch[0]["update"];
        assert_eq!(update["beforeLen"], 5);
        assert_eq!(update["afterLen"], 6);
        assert_eq!(update["edits"], json!([{"from":3,"to":5,"insert":"界🚀"}]));
        adapter
            .call(
                &mut core,
                "apply",
                json!({"id":"doc","command":{
                    "kind":"undo","base":edited.snapshot.version,
                    "context":{"metadata":{"redo":true},"positions":[4,6]}
                }}),
            )
            .await
            .unwrap();
        let batch = adapter.take_mutations(&mut core).unwrap();
        assert_eq!(batch.len(), 1);
        let update = &batch[0]["update"];
        assert_eq!(update["beforeLen"], 6);
        assert_eq!(update["afterLen"], 5);
        assert_eq!(update["edits"], json!([{"from":3,"to":6,"insert":"甲é"}]));
        assert_eq!(update["restored"]["metadata"], metadata);
        assert_eq!(update["restored"]["positions"], json!([3, 5]));
        assert_eq!(core.read("doc").unwrap().snapshot.text.as_ref(), "A😀甲é");
    });
}

#[test]
fn version_codec_preserves_exact_u64_peers_and_rejects_noncanonical_clocks() {
    let identity = DocumentIdentity {
        document_id: "doc".into(),
        history_id: "history".into(),
    };
    let value = json!({"identity":identity,"clocks":{
        "9007199254740993":7,"18446744073709551615":2147483647
    }});
    let version: Version = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(&version).unwrap(), value);
    assert_eq!(version.clock(9_007_199_254_740_993), 7);
    assert_eq!(version.clock(u64::MAX), i32::MAX);
    let decoded = Version::decode(identity.clone(), &version.encode().unwrap()).unwrap();
    assert_eq!(decoded, version);
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    for (peer, count) in [
        ("01", json!(1)),
        ("+1", json!(1)),
        ("18446744073709551616", json!(1)),
        ("peer", json!(1)),
        ("1", json!(0)),
        ("1", json!(-1)),
        ("1", json!(2147483648_u64)),
        ("1", json!(1.5)),
        ("1", json!("1")),
    ] {
        let mut clocks = serde_json::Map::new();
        clocks.insert(peer.into(), count);
        assert!(
            serde_json::from_value::<Version>(json!({"identity":identity,"clocks":clocks}))
                .is_err(),
            "{peer}"
        );
    }
}

#[test]
fn wire_anchor_resolution_is_a_utf16_number_array_without_refreshed_objects() {
    block_on(async {
        let mut core = replica("A😀甲é").await;
        let mut adapter = EditorAdapter::default();
        let version = core.read("doc").unwrap().snapshot.version;
        let anchors = adapter
            .call(
                &mut core,
                "anchors_at",
                json!({
                    "id":"doc","version":version,"positions":[[3,"before"],[3,"after"],[5,"after"]]
                }),
            )
            .await
            .unwrap();
        assert_eq!(anchors.as_array().unwrap().len(), 3);
        let roundtrip: Value =
            serde_json::from_str(&serde_json::to_string(&anchors).unwrap()).unwrap();
        core.edit("doc", [(5..5, "🚀")]).await.unwrap();
        let checkpoint = core.read("doc").unwrap().snapshot.version;
        let offsets = adapter
            .call(
                &mut core,
                "resolve_anchors",
                json!({
                    "id":"doc","checkpoint":checkpoint,"anchors":roundtrip
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            offsets,
            json!([core.status("doc").unwrap().version, [3, 5, 7]])
        );
        assert!(offsets[1].as_array().unwrap().iter().all(Value::is_u64));
    });
}

#[test]
fn wire_metadata_does_not_alias_a_native_callers_undo_tag() {
    block_on(async {
        let mut core = replica("A").await;
        let _ = core
            .edit_with(
                "doc",
                [(1..1, " native")],
                EditOptions {
                    undo: UndoContext {
                        tag: Some(1),
                        positions: vec![1],
                    },
                    ..EditOptions::default()
                },
            )
            .await
            .unwrap();
        core.take_mutations();
        let mut adapter = EditorAdapter::default();
        let base = core.status("doc").unwrap().version;
        adapter
            .call(
                &mut core,
                "apply",
                json!({"id":"doc","command":{
                    "kind":"edit","base":base,
                    "input":{"kind":"edits","edits":[{"from":8,"to":8,"insert":" wire"}]},
                    "undo":{"metadata":{"owner":"wire"}}
                }}),
            )
            .await
            .unwrap();
        adapter.take_mutations(&mut core).unwrap();
        for expected in [json!({"owner":"wire"}), Value::Null] {
            let base = core.status("doc").unwrap().version;
            adapter
                .call(
                    &mut core,
                    "apply",
                    json!({"id":"doc","command":{"kind":"undo","base":base}}),
                )
                .await
                .unwrap();
            let batch = adapter.take_mutations(&mut core).unwrap();
            assert_eq!(batch[0]["update"]["restored"]["metadata"], expected);
        }
        assert_eq!(core.read("doc").unwrap().snapshot.text.as_ref(), "A");
    });
}
