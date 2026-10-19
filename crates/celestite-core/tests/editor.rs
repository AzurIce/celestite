mod support;
use celestite_buffer::Buffer;
use celestite_buffer::types::{EditOptions, UndoContext};
use celestite_core::{
    editor::{EditorCore, EditorOptions, ExternalChangePolicy},
    error::{EditorResult, ErrorCode},
    fs::FileSystem,
    preview::{
        PreviewCompletion, PreviewOutcome, PreviewOutput, PreviewTask, sessions::PreviewController,
    },
    protocol::editor::EditorAdapter,
};
use futures_lite::future::block_on;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use support::{TestFs, identity};

async fn open(files: TestFs) -> EditorResult<EditorCore<TestFs>> {
    EditorCore::<TestFs>::open_with_options(
        identity(),
        Some(files),
        None,
        EditorOptions {
            clock: Arc::new(|| 1000),
            ..Default::default()
        },
    )
    .await
}
fn preview_task<F: FileSystem>(
    core: &EditorCore<F>,
    preview: &mut PreviewController,
    id: &str,
) -> PreviewTask {
    preview.synchronize(&core.document_source(&[]), 1000);
    let ids = preview.required_snapshots(id).unwrap();
    preview
        .take_task(id, &core.document_source(&ids), 1000)
        .unwrap()
        .unwrap()
}
fn preview_result(task: &PreviewTask) -> PreviewCompletion {
    PreviewCompletion {
        task_id: task.ticket.task_id.clone(),
        outcome: PreviewOutcome::Success {
            output: PreviewOutput {
                used_components: vec![],
                html: "<p>result</p>".into(),
                diagnostics: vec![],
                source_map: vec![],
            },
        },
    }
}
async fn replace(core: &mut EditorCore<TestFs>, id: &str, text: &str) {
    core.replace_text(id, text).unwrap();
}

#[test]
fn preview_rename_and_deletion_revoke_tasks_even_without_a_text_change() {
    block_on(async {
        let backend = TestFs::with_file("a.md", b"body");
        let mut core = open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let mut preview = PreviewController::default();
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe(&id, "client", 1000).unwrap();
        let old = preview_task(&core, &mut preview, &id);
        core.rename("a.md", "moved.md").await.unwrap();
        preview.synchronize(&core.document_source(&[]), 1000);
        let state = preview.state(&id).unwrap();
        assert_eq!(state.target.version, old.ticket.version);
        assert_eq!(state.target.path, "moved.md");
        assert!(!preview.complete(preview_result(&old)));
        preview.retry(&id, 1000).unwrap();
        let moved = preview_task(&core, &mut preview, &id);
        assert_eq!(moved.ticket.path, "moved.md");
        core.remove("moved.md", false).await.unwrap();
        preview.synchronize(&core.document_source(&[]), 1000);
        assert!(!preview.complete(preview_result(&moved)));
        assert!(preview.state(&id).is_err());
        assert!(core.read(&id).unwrap().status.deleted);
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "body");
        backend.put("moved.md", b"new file");
        let new_id = core.open_file("moved.md").await.unwrap();
        assert_ne!(id, new_id);
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe(&new_id, "client", 1000).unwrap();
        assert!(!preview.complete(preview_result(&moved)));
        assert_eq!(
            preview_task(&core, &mut preview, &new_id).source,
            "new file"
        );
    });
}

#[test]
fn external_conflict_discard_and_overwrite_preserve_text_encoding() {
    block_on(async {
        let backend = TestFs::with_file("a.md", "\u{feff}old\r\n".as_bytes());
        let mut core = open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        replace(&mut core, &id, "draft\n").await;
        backend.put("a.md", b"external\n");
        assert_eq!(
            core.save(&id, None).await.unwrap_err().code,
            ErrorCode::Conflict
        );
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "draft\n");
        core.resolve(&id, "overwrite").await.unwrap();
        assert_eq!(backend.bytes("a.md"), "\u{feff}draft\r\n".as_bytes());
        replace(&mut core, &id, "second").await;
        backend.put("a.md", b"external again");
        core.resolve(&id, "discard").await.unwrap();
        let state = core.read(&id).unwrap();
        assert_eq!(state.snapshot.text.as_ref(), "external again");
        assert!(!state.undo.can_undo && !state.status.dirty && !state.status.conflict);
    });
}

#[test]
fn undo_groups_follow_caller_gesture_ids_not_the_injected_clock() {
    block_on(async {
        let backend = TestFs::with_file("a.md", b"");
        let now = Arc::new(AtomicU64::new(1000));
        let clock = now.clone();
        let mut core = EditorCore::<TestFs>::open_with_options(
            identity(),
            Some(backend),
            None,
            EditorOptions {
                clock: Arc::new(move || clock.load(Ordering::Relaxed)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let id = core.open_file("a.md").await.unwrap();
        for (text, group, elapsed) in [
            ("a", "gesture-1", 0),
            ("b", "gesture-1", 2000),
            ("c", "gesture-2", 2001),
        ] {
            now.store(1000 + elapsed, Ordering::Relaxed);
            let state = core.read(&id).unwrap().snapshot;
            let end = state.text.len();
            core.edit_with(
                &id,
                [(end..end, text)],
                EditOptions {
                    group: Some(group.into()),
                    undo: UndoContext::default(),
                },
            )
            .unwrap();
        }
        core.undo(&id).unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "ab");
        core.undo(&id).unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "");
        core.redo(&id).unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "ab");
        core.redo(&id).unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "abc");
    });
}

#[test]
fn autosave_deadlines_follow_each_cores_clock_without_backend_time() {
    block_on(async {
        let mut cores = Vec::new();
        for epoch in [1000, 100_000] {
            let clock = Arc::new(AtomicU64::new(epoch));
            let source = clock.clone();
            // The backend supplies only storage. Each owner has its own clock,
            // including when a different owner uses a different epoch.
            let backend = TestFs::with_file("a.md", b"saved");
            let mut core = EditorCore::<TestFs>::open_with_options(
                identity(),
                Some(backend.clone()),
                None,
                EditorOptions {
                    clock: Arc::new(move || source.load(Ordering::Relaxed)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let id = core.open_file("a.md").await.unwrap();
            core.replace_text(&id, "draft").unwrap();
            assert_eq!(core.read(&id).unwrap().autosave_delay, Some(800));
            cores.push((core, backend, clock, id, epoch));
        }
        for elapsed in [100, 4199, 4200, 4500, 5000, 60_000] {
            let (core, backend, clock, id, epoch) = &cores[0];
            clock.store(epoch + elapsed, Ordering::Relaxed);
            assert_eq!(
                core.read(id).unwrap().autosave_delay,
                Some(800.min(5000_u64.saturating_sub(elapsed))),
            );
            assert_eq!(backend.bytes("a.md"), b"saved");
            let (other, _, _, other_id, _) = &cores[1];
            assert_eq!(other.read(other_id).unwrap().autosave_delay, Some(800));
        }
        let (core, backend, clock, id, epoch) = &mut cores[0];
        core.save(id, None).await.unwrap();
        assert_eq!(core.read(id).unwrap().autosave_delay, None);
        assert_eq!(backend.bytes("a.md"), b"draft");
        clock.store(*epoch + 70_000, Ordering::Relaxed);
        core.replace_text(id, "new draft").unwrap();
        assert_eq!(core.read(id).unwrap().autosave_delay, Some(800));
        clock.store(*epoch + 74_750, Ordering::Relaxed);
        assert_eq!(core.read(id).unwrap().autosave_delay, Some(250));
    });
}

#[test]
fn documents_keep_separate_histories_and_reopen_without_reseeding_within_one_owner() {
    block_on(async {
        let backend = TestFs::with_file("a.md", "A😀".as_bytes());
        backend.put("b.md", b"B");
        let mut core = open(backend).await.unwrap();
        let first = core.open_file("a.md").await.unwrap();
        let second = core.open_file("b.md").await.unwrap();
        assert_ne!(first, second);
        assert_ne!(
            core.read(&first).unwrap().status.version.identity(),
            core.read(&second).unwrap().status.version.identity()
        );
        core.edit(&first, [(5..5, "!")]).unwrap();
        let mutations = core.take_mutations();
        assert_eq!(mutations.len(), 1);
        assert_eq!(mutations[0].document.status.id, first);
        assert_eq!(mutations[0].document.snapshot.text.as_ref(), "A😀!");
        assert_eq!(core.read(&second).unwrap().snapshot.text.as_ref(), "B");
        assert_eq!(core.open_file("a.md").await.unwrap(), first);
        assert_eq!(core.read(&first).unwrap().snapshot.text.as_ref(), "A😀!");
    });
}

#[test]
fn import_admission_checks_pending_causal_history_within_the_live_session() {
    block_on(async {
        let files = TestFs::with_file("a.md", b"base");
        let mut core = open(files).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let mut peer =
            Buffer::from_snapshot_with_peer_id(&core.snapshot(&id).unwrap(), 42).unwrap();
        let start = peer.version();
        let _ = peer.edit([(4..4, " next")]).unwrap();
        let first = peer.export_updates_since(&start).unwrap();
        let middle = peer.version();
        let _ = peer.edit([(9..9, "\r")]).unwrap();
        let last = peer.export_updates_since(&middle).unwrap();
        assert!(core.import(&id, last).unwrap().pending);
        let before = core.read(&id).unwrap();
        assert_eq!(
            core.prepare_import(&id, first.clone()).unwrap_err().code,
            ErrorCode::InvalidEdit
        );
        assert_eq!(
            core.import(&id, first).unwrap_err().code,
            ErrorCode::InvalidEdit
        );
        let after = core.read(&id).unwrap();
        assert_eq!(after.snapshot, before.snapshot);
        assert_eq!(after.peer_id, before.peer_id);
        assert_eq!(after.undo, before.undo);
    });
}

#[test]
fn recovery_checkpoint_deadline_is_bounded_and_rearms_only_after_new_input() {
    block_on(async {
        let files = TestFs::with_file("a.md", b"saved");
        let recovery = TestFs::default();
        let now = Arc::new(AtomicU64::new(1000));
        let clock = now.clone();
        let mut core = EditorCore::open_with_options(
            identity(),
            Some(files),
            Some(recovery.clone()),
            EditorOptions {
                clock: Arc::new(move || clock.load(Ordering::Relaxed)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let id = core.open_file("a.md").await.unwrap();
        assert!(core.read(&id).unwrap().recovery_delay.is_none());
        let writes = recovery.writes();
        core.replace_text(&id, "draft").unwrap();
        assert_eq!(core.read(&id).unwrap().recovery_delay, Some(500));
        now.store(1200, Ordering::Relaxed);
        core.replace_text(&id, "newer draft").unwrap();
        assert_eq!(core.read(&id).unwrap().recovery_delay, Some(300));
        now.store(1499, Ordering::Relaxed);
        assert_eq!(core.read(&id).unwrap().recovery_delay, Some(1));
        now.store(1500, Ordering::Relaxed);
        assert_eq!(core.read(&id).unwrap().recovery_delay, Some(0));
        now.store(1600, Ordering::Relaxed);
        assert_eq!(core.read(&id).unwrap().recovery_delay, Some(0));
        assert_eq!(recovery.writes(), writes, "edits perform no recovery IO");
        core.checkpoint().await.unwrap();
        assert!(core.read(&id).unwrap().recovery_delay.is_none());
        assert!(recovery.writes() > writes);

        now.store(2000, Ordering::Relaxed);
        recovery.fail_writes(true);
        core.replace_text(&id, "unprotected draft").unwrap();
        assert!(core.checkpoint().await.is_err());
        assert!(core.status(&id).unwrap().recovery_error.is_some());
        now.store(3000, Ordering::Relaxed);
        assert!(core.read(&id).unwrap().recovery_delay.is_none());
        core.replace_text(&id, "latest draft").unwrap();
        assert_eq!(core.read(&id).unwrap().recovery_delay, Some(500));
        recovery.fail_writes(false);
        core.checkpoint().await.unwrap();
        assert!(core.read(&id).unwrap().recovery_delay.is_none());
        assert!(core.status(&id).unwrap().recovery_error.is_none());

        let mut volatile = open(TestFs::with_file("a.md", b"saved")).await.unwrap();
        let id = volatile.open_file("a.md").await.unwrap();
        volatile.replace_text(&id, "draft").unwrap();
        assert!(volatile.read(&id).unwrap().recovery_delay.is_none());
    });
}

#[test]
fn checkpoint_finishes_other_documents_and_stops_all_due_timers_after_a_failure() {
    block_on(async {
        let files = TestFs::with_file("a.md", b"saved A");
        files.put("b.md", b"saved B");
        let recovery = TestFs::default();
        let now = Arc::new(AtomicU64::new(1000));
        let clock = now.clone();
        let mut core = EditorCore::open_with_options(
            identity(),
            Some(files),
            Some(recovery.clone()),
            EditorOptions {
                clock: Arc::new(move || clock.load(Ordering::Relaxed)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let a = core.open_file("a.md").await.unwrap();
        let b = core.open_file("b.md").await.unwrap();
        core.replace_text(&a, "draft A").unwrap();
        core.replace_text(&b, "draft B").unwrap();
        now.store(1500, Ordering::Relaxed);
        assert_eq!(core.read(&a).unwrap().recovery_delay, Some(0));
        assert_eq!(core.read(&b).unwrap().recovery_delay, Some(0));

        let writes = recovery.writes();
        recovery.state.lock().unwrap().fail_write_number = Some(writes + 1);
        assert_eq!(core.checkpoint().await.unwrap_err().code, ErrorCode::Io);
        assert_eq!(
            recovery.writes(),
            writes + 3,
            "both drafts and the intent are attempted"
        );
        let documents = core.resident().unwrap();
        assert!(
            documents
                .iter()
                .all(|document| document.recovery_delay.is_none())
        );
        assert!(
            documents
                .iter()
                .all(|document| document.status.recovery_error.is_some())
        );
        let drafts = recovery
            .files()
            .into_iter()
            .filter(|(path, _)| path.starts_with("recovery/"))
            .map(|(_, bytes)| serde_json::from_slice::<serde_json::Value>(&bytes).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            drafts.len(),
            1,
            "the later document must still be checkpointed"
        );
        assert!(matches!(
            drafts[0]["text"].as_str(),
            Some("draft A" | "draft B")
        ));

        core.checkpoint().await.unwrap();
        assert!(core.resident().unwrap().iter().all(|document| {
            document.recovery_delay.is_none() && document.status.recovery_error.is_none()
        }));
        assert_eq!(
            recovery
                .files()
                .keys()
                .filter(|path| path.starts_with("recovery/"))
                .count(),
            2,
        );
    });
}

#[test]
fn failed_plaintext_checkpoint_delivers_each_accepted_edit_and_allows_further_edits() {
    block_on(async {
        let files = TestFs::with_file("a.md", b"saved");
        let recovery = TestFs::default();
        let mut core = EditorCore::open(identity(), Some(files.clone()), Some(recovery.clone()))
            .await
            .unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.take_mutations();
        recovery.fail_writes(true);
        let mut adapter = EditorAdapter::default();
        for (index, text) in ["draft", "newer draft"].into_iter().enumerate() {
            let base = core.status(&id).unwrap().version;
            adapter
                .call(
                    &mut core,
                    "apply",
                    json!({"id":id,"command":{
                        "kind":"edit","base":base,"input":{"kind":"text","text":text}
                    }}),
                )
                .await
                .unwrap();
            let mutations = adapter.take_mutations(&mut core).unwrap();
            assert_eq!(mutations.len(), 1);
            assert_eq!(mutations[0]["document"]["snapshot"]["text"], text);
            if index == 0 {
                assert!(mutations[0]["document"]["recoveryError"].is_null());
            }
            assert!(mutations[0].get("history").is_none());
            assert!(adapter.take_mutations(&mut core).unwrap().is_empty());
            assert!(core.read(&id).unwrap().undo.can_undo);
            assert!(
                adapter
                    .call(&mut core, "checkpoint", json!({}))
                    .await
                    .is_err()
            );
            assert!(core.status(&id).unwrap().recovery_error.is_some());
        }
        assert!(core.checkpoint().await.is_err());
        assert_eq!(files.bytes("a.md"), b"saved");
        recovery.fail_writes(false);
        adapter
            .call(&mut core, "checkpoint", json!({}))
            .await
            .unwrap();
        assert!(core.status(&id).unwrap().recovery_error.is_none());
        let version = core.status(&id).unwrap().version;
        core.close().await.unwrap();
        drop(core);
        let mut restored = EditorCore::open(identity(), Some(files), Some(recovery))
            .await
            .unwrap();
        let new_id = restored.open_file("a.md").await.unwrap();
        let state = restored.read(&new_id).unwrap();
        assert_eq!(state.snapshot.text.as_ref(), "newer draft");
        assert_ne!(state.status.version.identity(), version.identity());
        assert!(!state.undo.can_undo);
    });
}

#[test]
fn a_failed_save_intent_checkpoint_never_starts_the_projection_write() {
    block_on(async {
        let files = TestFs::with_file("a.md", b"saved");
        let recovery = TestFs::default();
        let mut core = EditorCore::open(identity(), Some(files.clone()), Some(recovery.clone()))
            .await
            .unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.replace_text(&id, "draft").unwrap();
        let writes = files.writes();
        recovery.fail_writes(true);
        assert!(core.save(&id, None).await.is_err());
        assert_eq!(files.writes(), writes);
        assert_eq!(files.bytes("a.md"), b"saved");
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "draft");
        core.replace_text(&id, "newer draft").unwrap();
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "newer draft"
        );
        recovery.fail_writes(false);
        core.save(&id, None).await.unwrap();
        assert_eq!(files.bytes("a.md"), b"newer draft");
        assert!(!core.status(&id).unwrap().dirty);
    });
}

#[test]
fn a_later_file_error_does_not_erase_an_accepted_external_change_receipt() {
    block_on(async {
        let files = TestFs::with_file("a.md", b"old");
        files.put("existing.md", "untouched");
        let mut core = EditorCore::<TestFs>::open_with_options(
            identity(),
            Some(files.clone()),
            None,
            EditorOptions {
                external_changes: ExternalChangePolicy::Merge,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.take_mutations();
        files.put("a.md", "external");
        let mut adapter = EditorAdapter::default();
        let failure = adapter
            .call(
                &mut core,
                "file",
                json!({
                    "method":"rename","from":"a.md","to":"existing.md"
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(failure.code, ErrorCode::AlreadyExists);
        let batch = adapter.take_mutations(&mut core).unwrap();
        assert!(
            batch
                .iter()
                .any(|mutation| mutation["document"]["snapshot"]["text"] == "external")
        );
        assert!(adapter.take_mutations(&mut core).unwrap().is_empty());
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "external");
        assert_eq!(files.bytes("existing.md"), b"untouched");
    });
}

#[test]
fn file_download_saves_loaded_text_but_readonly_snapshots_do_not() {
    block_on(async {
        let files = TestFs::with_file("a.md", b"saved");
        let mut core = open(files.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.replace_text(&id, "draft").unwrap();
        assert_eq!(
            core.file_read_snapshot("a.md").await.unwrap().data,
            b"saved"
        );
        assert_eq!(core.file_read("a.md").await.unwrap(), b"draft");
        assert_eq!(files.bytes("a.md"), b"draft");
        let status = serde_json::to_value(core.status(&id).unwrap()).unwrap();
        for obsolete in ["persistedVersion", "persistenceError"] {
            assert!(status.get(obsolete).is_none());
        }
        assert!(status.get("recoveryError").is_some());
    });
}
