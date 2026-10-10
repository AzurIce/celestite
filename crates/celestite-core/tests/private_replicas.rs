use celestite_buffer::Buffer;
use celestite_buffer::types::{DocumentIdentity, HistoryPacket, Version};
use celestite_core::backend::memory::MemoryBackend;
use celestite_core::editor::EditorCore;
use celestite_core::editor::replica::ReplicaDocument;
use celestite_core::editor::types::ReplicaHostState;
use celestite_core::instance::{InstanceIdentity, Vault};
use celestite_core::preview::sessions::PreviewController;
use celestite_core::preview::{PreviewCompletion, PreviewOutcome, PreviewOutput};
use celestite_core::protocol::editor::EditorAdapter;
use futures_lite::future::block_on;
use serde_json::json;

fn with_unseen_clock(version: &Version) -> Version {
    let mut value = serde_json::to_value(version).unwrap();
    let peer = (0..u64::MAX)
        .find(|peer| version.clock(*peer) == 0)
        .unwrap();
    value["clocks"][peer.to_string()] = json!(1);
    serde_json::from_value(value).unwrap()
}

fn seed(id: &str, text: &str) -> HistoryPacket {
    Buffer::new(
        DocumentIdentity {
            document_id: id.into(),
            history_id: format!("history-{id}"),
        },
        text,
    )
    .unwrap()
    .export_snapshot()
    .unwrap()
}
fn hosted(packet: HistoryPacket, path: &str, deleted: bool) -> ReplicaDocument {
    let snapshot = Buffer::from_snapshot(&packet).unwrap().snapshot();
    ReplicaDocument {
        packets: vec![packet],
        peer_id: None,
        state: ReplicaHostState {
            path: path.into(),
            version: snapshot.version,
            saved_content: snapshot.text.to_string(),
            file_revision: "disk".into(),
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
fn readonly_source_captures_eligible_bodies_without_effects_and_tracks_session_epochs() {
    block_on(async {
        let mut core = replica("client", seed("file", "A😀")).await;
        core.replace_replica_session(vec![
            hosted(core.snapshot("file").unwrap(), "a.md", false),
            hosted(seed("other", "other"), "b.md", false),
            hosted(seed("deleted", "deleted"), "deleted.md", true),
            hosted(seed("detached", "detached"), "detached.md", false),
        ])
        .await
        .unwrap();
        core.release_replica_document("detached").unwrap();
        let receipt = core.edit("file", [(5..5, "!")]).await.unwrap();
        let before = core.read("file").unwrap();
        let metadata = core.document_source(&[]);
        let mut catalogue = metadata
            .documents
            .iter()
            .map(|document| (document.id.as_str(), document.path.as_str()))
            .collect::<Vec<_>>();
        catalogue.sort();
        assert_eq!(catalogue, vec![("file", "a.md"), ("other", "b.md")]);
        assert!(metadata.snapshots.is_empty());
        for document in &metadata.documents {
            assert_eq!(document.version, core.status(&document.id).unwrap().version);
        }
        let captured = core.document_source(&[
            "file".into(),
            "missing".into(),
            "deleted".into(),
            "detached".into(),
        ]);
        assert_eq!(captured.documents.len(), 2);
        assert_eq!(captured.snapshots.len(), 1);
        assert_eq!(captured.snapshots[0].id, "file");
        assert_eq!(captured.snapshots[0].path, "a.md");
        assert_eq!(captured.snapshots[0].snapshot, before.snapshot);
        assert_eq!(captured.snapshots[0].snapshot.text.as_ref(), "A😀!");

        let mut preview = PreviewController::default();
        preview.synchronize(&metadata, 1000);
        preview.subscribe("file", "view", 1000).unwrap();
        let ids = preview.required_snapshots("file").unwrap();
        let task = preview
            .take_task("file", &core.document_source(&ids), 1000)
            .unwrap()
            .unwrap();
        let preview_before = serde_json::to_value(preview.state("file").unwrap()).unwrap();
        preview.take_events();
        // Catalogue and history export reads neither consume accepted receipts nor
        // modify personal undo or the derived consumer's running task.
        let history = core.snapshot("file").unwrap();
        let _ = core.updates("file", &before.snapshot.version).unwrap();
        preview.synchronize(&core.document_source(&[]), 1000);
        assert_eq!(core.read("file").unwrap().undo, before.undo);
        assert_eq!(
            serde_json::to_value(preview.state("file").unwrap()).unwrap(),
            preview_before
        );
        assert!(preview.take_events().is_empty());
        let delivered = core.take_mutations();
        assert_eq!(delivered.len(), 1);
        assert!(std::sync::Arc::ptr_eq(&delivered[0], &receipt));
        assert!(core.take_mutations().is_empty());

        let mut invalid = hosted(history.clone(), "a.md", false);
        invalid.state.version = with_unseen_clock(&invalid.state.version);
        assert!(core.replace_replica_session(vec![invalid]).await.is_err());
        assert_eq!(core.document_source(&[]).epoch, metadata.epoch);
        preview.synchronize(&core.document_source(&[]), 1000);
        assert_eq!(
            serde_json::to_value(preview.state("file").unwrap()).unwrap(),
            preview_before
        );
        core.replace_replica_session(vec![hosted(history, "a.md", false)])
            .await
            .unwrap();
        let replaced = core.document_source(&["file".into()]);
        assert_ne!(replaced.epoch, metadata.epoch);
        assert_eq!(
            replaced.snapshots[0].snapshot.version,
            before.snapshot.version
        );
        preview.synchronize(&replaced, 1000);
        assert!(!preview.complete(PreviewCompletion {
            task_id: task.ticket.task_id,
            outcome: PreviewOutcome::Success {
                output: PreviewOutput {
                    html: "late".into(),
                    diagnostics: vec![],
                    source_map: vec![],
                    used_components: vec![],
                },
            },
        }));
        core.replace_text("file", "changed").await.unwrap();
        assert_eq!(captured.snapshots[0].snapshot, before.snapshot);
        assert_eq!(captured.snapshots[0].snapshot.text.as_ref(), "A😀!");
    });
}

#[test]
fn native_session_replacement_preserves_undrained_accepted_receipts() {
    block_on(async {
        let packet = seed("file", "base");
        let mut core = replica("client", packet.clone()).await;
        core.take_mutations();
        let receipt = core.edit("file", [(4..4, " draft")]).await.unwrap();
        core.replace_replica_session(vec![hosted(packet, "a.md", false)])
            .await
            .unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text.as_ref(), "base");
        let batch = core.take_mutations();
        assert_eq!(batch.len(), 1);
        assert!(std::sync::Arc::ptr_eq(&batch[0], &receipt));
        assert_eq!(batch[0].document.snapshot.text.as_ref(), "base draft");
        assert!(batch[0].update.local_operation().is_some());
        assert!(core.take_mutations().is_empty());
    });
}

#[test]
fn adapter_delivers_old_session_effects_before_new_session_effects() {
    block_on(async {
        let packet = seed("file", "base");
        let mut core = replica("client", packet.clone()).await;
        let mut adapter = EditorAdapter::default();
        for (index, suffix) in [" old", " new"].into_iter().enumerate() {
            if index == 1 {
                let replacement = hosted(packet.clone(), "a.md", false);
                adapter
                    .call(
                        &mut core,
                        "replica_session",
                        json!({"documents":[{
                            "packets":replacement.packets,"state":replacement.state
                        }]}),
                    )
                    .await
                    .unwrap();
            }
            let base = core.status("file").unwrap().version;
            adapter
                .call(
                    &mut core,
                    "apply",
                    json!({"id":"file","command":{
                        "kind":"edit","base":base,
                        "input":{"kind":"edits","edits":[{"from":4,"to":4,"insert":suffix}]}
                    }}),
                )
                .await
                .unwrap();
        }
        let batch = adapter.take_mutations(&mut core).unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0]["document"]["snapshot"]["text"], "base old");
        assert_eq!(batch[1]["document"]["snapshot"]["text"], "base new");
        assert!(adapter.take_mutations(&mut core).unwrap().is_empty());
    });
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
            assert_eq!(core.read("new").unwrap().snapshot.text.as_ref(), "new");
            assert_eq!(core.read("base").unwrap_err().code, "NotFound");
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
        core.replace_text("A", "retained draft").await.unwrap();
        let original = core.read("A").unwrap();
        let mut preview = PreviewController::default();
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe("A", "view", 1000).unwrap();
        let mut invalid = hosted(b.clone(), "a.md", false);
        invalid.state.version = with_unseen_clock(&invalid.state.version);
        assert!(
            core.replace_replica_session(vec![hosted(a.clone(), "c.md", false), invalid])
                .await
                .is_err()
        );
        let retained = core.read("A").unwrap();
        assert_eq!(original.snapshot.version, retained.snapshot.version);
        assert_eq!(original.peer_id, retained.peer_id);
        assert!(retained.undo.can_undo);
        assert_eq!(retained.path, "a.md");
        // B precedes A, while B's new path was owned by A in the old session.
        core.replace_replica_session(vec![hosted(b, "a.md", false), hosted(a, "c.md", false)])
            .await
            .unwrap();
        assert_eq!(core.read("A").unwrap().path, "c.md");
        assert_eq!(core.read("B").unwrap().path, "a.md");
        assert!(!core.read("A").unwrap().undo.can_undo);
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe("A", "view", 1000).unwrap();
        assert_eq!(preview.state("A").unwrap().target.path, "c.md");
        preview.retry("A", 1000).unwrap();
        let ids = preview.required_snapshots("A").unwrap();
        assert!(
            preview
                .take_task("A", &core.document_source(&ids), 1000)
                .unwrap()
                .is_some()
        );
    });
}

#[test]
fn session_imports_catch_up_packets_and_close_does_not_require_write_permission() {
    block_on(async {
        let initial = seed("file", "seed");
        let mut source = Buffer::from_snapshot(&initial).unwrap();
        let before = source.version();
        let _ = source.edit([(0..0, "remote ")]).unwrap();
        let mut input = hosted(source.export_snapshot().unwrap(), "a.md", false);
        input.packets = vec![
            initial.clone(),
            source.export_updates_since(&before).unwrap(),
        ];
        input.state.read_only = true;
        let mut core = replica("client", initial).await;
        core.replace_replica_session(vec![input]).await.unwrap();
        assert_eq!(
            core.read("file").unwrap().snapshot.text.as_ref(),
            "remote seed"
        );
        let before = source.version();
        let _ = source.edit([(0..0, "next ")]).unwrap();
        core.import("file", source.export_updates_since(&before).unwrap())
            .await
            .unwrap();
        assert_eq!(
            core.read("file").unwrap().snapshot.text.as_ref(),
            "next remote seed"
        );
        assert_eq!(
            core.replace_text("file", "blocked").await.unwrap_err().code,
            "PermissionDenied"
        );
        core.close().await.unwrap();
    });
}

async fn replica(name: &str, packet: HistoryPacket) -> EditorCore<MemoryBackend> {
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
        let seed = seed("file", "A😀B");
        let mut a = replica("a", seed.clone()).await;
        let mut b = replica("b", seed.clone()).await;
        let mut c = replica("c", seed).await;
        let base = a.read("file").unwrap().snapshot.version;
        assert_ne!(
            a.read("file").unwrap().peer_id,
            b.read("file").unwrap().peer_id
        );
        for (core, text) in [(&mut a, "A😀aB"), (&mut b, "A😀bB")] {
            core.replace_text("file", text).await.unwrap();
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
        for core in [&a, &b, &c] {
            let state = core.read("file").unwrap();
            assert!(state.persisted_version.is_none());
            assert!(state.saved_version.is_none());
            assert!(state.autosave_delay.is_none());
        }
        assert!(a.read("file").unwrap().undo.can_undo);
        assert!(b.read("file").unwrap().undo.can_undo);
        assert!(!c.read("file").unwrap().undo.can_undo);
    });
}

#[test]
fn joining_a_known_history_does_not_reseed_or_alias_another_identity() {
    block_on(async {
        let packet = seed("file", "seed");
        let mut core = replica("client", packet.clone()).await;
        core.replace_text("file", "draft").await.unwrap();
        core.join("a.md", packet.clone()).await.unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text.as_ref(), "draft");
        assert!(core.join("../a.md", packet.clone()).await.is_err());
        assert!(core.join("b.md", packet.clone()).await.is_err());
        let mut other = packet.clone();
        other.identity.history_id = "different".into();
        assert_eq!(core.join("a.md", other).await.unwrap_err().code, "Conflict");
        // Stale caller checkpoints belong to the JSON protocol, not native ownership.
        assert_eq!(core.read("file").unwrap().snapshot.text.as_ref(), "draft");
    });
}

#[test]
fn host_receipts_and_session_replacement_keep_history_and_clear_personal_undo() {
    block_on(async {
        let packet = seed("file", "seed");
        let mut core = replica("client", packet.clone()).await;
        let other = seed("other", "other");
        core.join("other.md", other).await.unwrap();
        for (id, text) in [("file", "draft"), ("other", "keep other edit")] {
            core.replace_text(id, text).await.unwrap();
        }
        let mut state = hosted(packet.clone(), "a.md", false).state;
        state.version = core.read("file").unwrap().snapshot.version;
        state.file_revision = "remote-1".into();
        core.apply_host_state("file", state.clone()).await.unwrap();
        assert!(core.read("file").unwrap().autosave_delay.is_some());
        assert!(core.read("file").unwrap().persisted_version.is_none());
        let mut unseen = state.clone();
        unseen.version = with_unseen_clock(&unseen.version);
        assert!(core.apply_host_state("file", unseen).await.is_err());
        assert_eq!(core.read("file").unwrap().file_revision, "remote-1");
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
        assert_eq!(core.read("file").unwrap().snapshot.text.as_ref(), "draft");
        core.replace_replica_session(vec![
            hosted(packet, "a.md", false),
            hosted(other_packet, "other.md", false),
        ])
        .await
        .unwrap();
        assert_eq!(core.read("file").unwrap().snapshot.text.as_ref(), "seed");
        assert!(!core.read("file").unwrap().undo.can_undo);
        assert_eq!(
            core.read("other").unwrap().snapshot.text.as_ref(),
            "keep other edit"
        );
        assert!(!core.read("other").unwrap().undo.can_undo);
        let mut read_only = state;
        read_only.version = core.read("file").unwrap().snapshot.version;
        read_only.read_only = true;
        core.apply_host_state("file", read_only).await.unwrap();
        assert_eq!(
            core.replace_text("file", "blocked").await.unwrap_err().code,
            "PermissionDenied"
        );
        let mut preview = PreviewController::default();
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe("file", "readonly-view", 1000).unwrap();
        let ids = preview.required_snapshots("file").unwrap();
        assert!(
            preview
                .take_task("file", &core.document_source(&ids), 1000)
                .unwrap()
                .is_some()
        );
    });
}

#[test]
fn a_closed_cache_can_rejoin_after_replacing_the_active_session_catalogue() {
    block_on(async {
        let closed = seed("closed", "cached");
        let active = seed("active", "active");
        let mut core = replica("client", closed.clone()).await;
        core.join_replica_document(hosted(active.clone(), "b.md", false))
            .await
            .unwrap();
        let peer_id = core.read("closed").unwrap().peer_id;
        let mut preview = PreviewController::default();
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe("closed", "view", 1000).unwrap();
        core.replace_replica_session(vec![hosted(active, "b.md", false)])
            .await
            .unwrap();
        assert_eq!(core.read("closed").unwrap_err().code, "NotFound");
        preview.synchronize(&core.document_source(&[]), 1000);
        assert!(preview.state("closed").is_err());
        core.join_replica_document(hosted(closed, "a.md", false))
            .await
            .unwrap();
        assert_eq!(
            core.read("closed").unwrap().snapshot.text.as_ref(),
            "cached"
        );
        assert_ne!(core.read("closed").unwrap().peer_id, peer_id);
    });
}

#[test]
fn released_replica_caches_keep_undo_without_reserving_a_live_path() {
    block_on(async {
        let mut core = replica("client", seed("old", "old")).await;
        // Make this document a host-owned replica before exercising its lifecycle.
        let packet = core.snapshot("old").unwrap();
        core.replace_replica_session(vec![hosted(packet.clone(), "a.md", false)])
            .await
            .unwrap();
        core.replace_text("old", "draft").await.unwrap();
        let state = core.read("old").unwrap();
        core.release_replica_document("old").unwrap();
        assert!(!core.read("old").unwrap().deleted);
        assert!(core.read("old").unwrap().undo.can_undo);
        assert_eq!(core.undo("old").await.unwrap_err().code, "Closed");
        let mut preview = PreviewController::default();
        preview.synchronize(&core.document_source(&[]), 1000);
        assert!(preview.subscribe("old", "view", 1000).is_err());
        core.join_replica_document(hosted(seed("new", "new"), "a.md", false))
            .await
            .unwrap();
        core.apply_host_state(
            "old",
            ReplicaHostState {
                path: "renamed.md".into(),
                version: state.snapshot.version,
                ..hosted(packet, "a.md", false).state
            },
        )
        .await
        .unwrap();
        assert_eq!(core.read("old").unwrap().peer_id, state.peer_id);
        assert!(core.read("old").unwrap().undo.can_undo);
        core.undo("old").await.unwrap();
        assert_eq!(core.read("old").unwrap().snapshot.text.as_ref(), "old");
        assert_eq!(core.read("new").unwrap().snapshot.text.as_ref(), "new");
    });
}
