use celestite_buffer::Buffer;
use celestite_buffer::types::{EditOptions, UndoContext};
use celestite_core::backend::{
    Backend, DirectoryIntent, DocumentHeader, EditorError, EditorResult, FileEntry, FileSnapshot,
    JournalEntry, StoredDocument,
};
use celestite_core::editor::EditorCore;
use celestite_core::editor::types::HistoryCommit;
use celestite_core::instance::{InstanceIdentity, Vault};
use celestite_core::preview::sessions::PreviewController;
use celestite_core::preview::{PreviewCompletion, PreviewOutcome, PreviewOutput, PreviewTask};
use celestite_core::protocol::editor::EditorAdapter;
use futures_lite::future::block_on;
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

#[derive(Default)]
struct Storage {
    now: u64,
    files: BTreeMap<String, Vec<u8>>,
    documents: BTreeMap<String, StoredDocument>,
    intent: Option<DirectoryIntent>,
    fail_commit: bool,
    fail_receipt: bool,
    fail_rename_receipt: bool,
}
#[derive(Clone)]
struct MemoryBackend {
    identity: InstanceIdentity,
    storage: Rc<RefCell<Storage>>,
    projection: bool,
}
impl MemoryBackend {
    fn new(bytes: &[u8]) -> Self {
        let storage = Rc::new(RefCell::new(Storage::default()));
        storage
            .borrow_mut()
            .files
            .insert("a.md".into(), bytes.into());
        Self {
            identity: InstanceIdentity {
                vault: Vault {
                    vault_id: "vault".into(),
                    history_id: "vault-history".into(),
                },
                instance_id: "instance".into(),
            },
            storage,
            projection: true,
        }
    }
}
fn io() -> EditorError {
    EditorError::new("IO", "injected commit failure", "")
}

fn preview_task<B: Backend>(
    core: &EditorCore<B>,
    preview: &mut PreviewController,
    id: &str,
) -> PreviewTask {
    preview.synchronize(&core.document_source(&[]), 1000);
    let ids = preview.required_snapshots(id).unwrap();
    let source = core.document_source(&ids);
    preview.take_task(id, &source, 1000).unwrap().unwrap()
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

#[test]
fn import_admission_uses_the_buffers_pending_history_even_after_recovery() {
    block_on(async {
        let backend = MemoryBackend::new(b"base");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let mut peer =
            Buffer::from_snapshot_with_peer_id(&core.snapshot(&id).unwrap(), 42).unwrap();
        let start = peer.version();
        let _ = peer.edit([(4..4, " next")]).unwrap();
        let first = peer.export_updates_since(&start).unwrap();
        let middle = peer.version();
        let _ = peer.edit([(9..9, "\r")]).unwrap();
        let last = peer.export_updates_since(&middle).unwrap();
        assert!(core.import(&id, last).await.unwrap().pending);

        for recover in [false, true] {
            if recover {
                core = EditorCore::open(backend.clone()).await.unwrap();
            }
            let before = core.read(&id).unwrap();
            assert_eq!(
                core.prepare_import(&id, first.clone()).unwrap_err().code,
                "InvalidEdit"
            );
            assert_eq!(
                core.import(&id, first.clone()).await.unwrap_err().code,
                "InvalidEdit"
            );
            let after = core.read(&id).unwrap();
            assert_eq!(after.snapshot, before.snapshot);
            assert_eq!(after.peer_id, before.peer_id);
            assert_eq!(after.undo, before.undo);
            assert_eq!(backend.storage.borrow().documents[&id].0.sequence, 1);
        }
    });
}

#[test]
fn preview_rename_and_deletion_revoke_tasks_even_without_a_text_change() {
    block_on(async {
        let backend = MemoryBackend::new(b"body");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
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
        assert!(core.read(&id).unwrap().deleted);
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "body");
        backend
            .storage
            .borrow_mut()
            .files
            .insert("moved.md".into(), b"new file".into());
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

fn revision(data: &[u8]) -> String {
    format!("{data:?}")
}
impl Backend for MemoryBackend {
    fn identity(&self) -> &InstanceIdentity {
        &self.identity
    }
    fn persistent(&self) -> bool {
        true
    }
    fn has_projection(&self) -> bool {
        self.projection
    }
    fn now_ms(&self) -> u64 {
        1000 + self.storage.borrow().now
    }
    fn new_id(&self) -> EditorResult<String> {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Ok(format!(
            "id-{}",
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }
    async fn load(&mut self) -> EditorResult<Vec<StoredDocument>> {
        Ok(self.storage.borrow().documents.values().cloned().collect())
    }
    async fn commit(
        &mut self,
        header: &DocumentHeader,
        entry: Option<&JournalEntry>,
    ) -> EditorResult<()> {
        let mut state = self.storage.borrow_mut();
        if state.fail_commit || (state.fail_receipt && header.pending_write.is_none()) {
            return Err(io());
        }
        let value = state
            .documents
            .entry(header.id.clone())
            .or_insert_with(|| (header.clone(), vec![]));
        if let Some(entry) = entry
            && value.1.len() < header.sequence as usize
        {
            value.1.push(entry.clone());
        }
        value.0 = header.clone();
        Ok(())
    }
    async fn directory_intent(&mut self) -> EditorResult<Option<DirectoryIntent>> {
        Ok(self.storage.borrow().intent.clone())
    }
    async fn set_directory_intent(&mut self, intent: Option<&DirectoryIntent>) -> EditorResult<()> {
        self.storage.borrow_mut().intent = intent.cloned();
        Ok(())
    }
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        Ok(self.storage.borrow().files.get(path).map(|data| FileEntry {
            path: path.into(),
            kind: "file".into(),
            size: Some(data.len() as u64),
            modified_at: None,
        }))
    }
    async fn read_file(&self, path: &str, _limit: Option<u64>) -> EditorResult<FileSnapshot> {
        assert!(
            self.projection,
            "history-only core must not access file projection"
        );
        let state = self.storage.borrow();
        let data = state
            .files
            .get(path)
            .ok_or_else(|| EditorError::new("NotFound", "missing file", path))?;
        Ok(FileSnapshot {
            data: data.clone(),
            revision: revision(data),
        })
    }
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        _mode: &str,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        let mut state = self.storage.borrow_mut();
        let previous = state
            .files
            .get(path)
            .ok_or_else(|| EditorError::new("NotFound", "missing file", path))?;
        if expected.is_some_and(|value| value != revision(previous)) {
            return Err(EditorError::new("Conflict", "changed on disk", path));
        }
        state.files.insert(path.into(), data.into());
        Ok(revision(data))
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        let mut state = self.storage.borrow_mut();
        if from == to {
            return if state.files.contains_key(from) {
                Ok(())
            } else {
                Err(EditorError::new("NotFound", "missing", from))
            };
        }
        if state.files.contains_key(to) {
            return Err(EditorError::new("AlreadyExists", "target exists", to));
        }
        let data = state
            .files
            .remove(from)
            .ok_or_else(|| EditorError::new("NotFound", "missing", from))?;
        state.files.insert(to.into(), data);
        if state.fail_rename_receipt {
            state.fail_commit = true;
        }
        Ok(())
    }
    async fn remove(&self, path: &str, _recursive: bool) -> EditorResult<()> {
        self.storage
            .borrow_mut()
            .files
            .remove(path)
            .ok_or_else(|| EditorError::new("NotFound", "missing", path))?;
        Ok(())
    }
}
async fn replace(core: &mut EditorCore<MemoryBackend>, id: &str, text: &str) {
    core.replace_text(id, text).await.unwrap();
}

#[test]
fn history_failure_keeps_accepted_draft_blocks_more_edits_and_can_retry() {
    block_on(async {
        let backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let persisted = core.read(&id).unwrap().persisted_version;
        backend.storage.borrow_mut().fail_commit = true;
        let receipt = core.replace_text(&id, "draft").await.unwrap();
        assert!(matches!(receipt.history, HistoryCommit::Failed { .. }));
        assert!(receipt.require_committed().is_err());
        let delivery = core.take_mutations();
        assert_eq!(delivery.len(), 1);
        assert!(std::sync::Arc::ptr_eq(&delivery[0], &receipt));
        let state = core.read(&id).unwrap();
        assert_eq!(state.snapshot.text.as_ref(), "draft");
        assert_eq!(state.persisted_version, persisted);
        assert!(
            state
                .persistence_error
                .unwrap()
                .contains("编辑历史尚未持久化")
        );
        let mut preview = PreviewController::default();
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe(&id, "client", 1000).unwrap();
        let task = preview_task(&core, &mut preview, &id);
        assert_eq!(task.source, "draft");
        preview.synchronize(&core.document_source(&[]), 1000);
        assert!(preview.complete(preview_result(&task)));
        assert!(core.undo(&id).await.is_err());
        assert_eq!(backend.storage.borrow().files["a.md"], b"old");
        backend.storage.borrow_mut().fail_commit = false;
        core.retry_history().await.unwrap();
        assert!(
            core.take_mutations().is_empty(),
            "retrying history must not repeat acceptance"
        );
        let journal = backend.storage.borrow().documents[&id].1.clone();
        assert_eq!(journal.len(), 1);
        assert_eq!(
            journal[0].packet.data,
            receipt.update.operation.as_ref().unwrap().data
        );
        assert_eq!(
            core.read(&id).unwrap().persisted_version,
            Some(core.read(&id).unwrap().snapshot.version)
        );
        core.undo(&id).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "old");
        core.redo(&id).await.unwrap();
        core.save(&id, None).await.unwrap();
        drop(core);
        let restored = EditorCore::open(backend).await.unwrap();
        assert_eq!(restored.read(&id).unwrap().snapshot.text.as_ref(), "draft");
        assert!(!restored.read(&id).unwrap().dirty);
    });
}
#[test]
fn write_completed_before_receipt_recovers_without_a_false_conflict() {
    block_on(async {
        let backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        replace(&mut core, &id, "new").await;
        let version = core.read(&id).unwrap().snapshot.version;
        backend.storage.borrow_mut().fail_receipt = true;
        assert!(core.save(&id, None).await.is_err());
        assert_eq!(backend.storage.borrow().files["a.md"], b"new");
        assert!(
            backend.storage.borrow().documents[&id]
                .0
                .pending_write
                .is_some()
        );
        drop(core);
        backend.storage.borrow_mut().fail_receipt = false;
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        core.save(&id, None).await.unwrap();
        let state = core.read(&id).unwrap();
        assert!(!state.dirty && !state.conflict);
        assert_eq!(state.saved_version, Some(version.clone()));
        assert_eq!(state.persisted_version, Some(version));
        assert!(
            backend.storage.borrow().documents[&id]
                .0
                .pending_write
                .is_none()
        );
        drop(core);
        assert!(
            !EditorCore::open(backend)
                .await
                .unwrap()
                .read(&id)
                .unwrap()
                .dirty
        );
    });
}
#[test]
fn external_conflict_discard_and_overwrite_preserve_text_encoding() {
    block_on(async {
        let backend = MemoryBackend::new("\u{feff}old\r\n".as_bytes());
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        replace(&mut core, &id, "draft\n").await;
        backend
            .storage
            .borrow_mut()
            .files
            .insert("a.md".into(), b"external\n".to_vec());
        assert_eq!(core.save(&id, None).await.unwrap_err().code, "Conflict");
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "draft\n");
        core.resolve(&id, "overwrite").await.unwrap();
        assert_eq!(
            backend.storage.borrow().files["a.md"],
            "\u{feff}draft\r\n".as_bytes()
        );
        replace(&mut core, &id, "second").await;
        backend
            .storage
            .borrow_mut()
            .files
            .insert("a.md".into(), b"external again".to_vec());
        core.resolve(&id, "discard").await.unwrap();
        let state = core.read(&id).unwrap();
        assert_eq!(state.snapshot.text.as_ref(), "external again");
        assert!(!state.undo.can_undo && !state.dirty && !state.conflict);
    });
}
#[test]
fn completed_move_recovers_identity_after_header_commit_failure() {
    block_on(async {
        let backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        replace(&mut core, &id, "draft").await;
        backend.storage.borrow_mut().fail_rename_receipt = true;
        assert!(core.rename("a.md", "b.md").await.is_err());
        assert!(backend.storage.borrow().intent.is_some());
        drop(core);
        backend.storage.borrow_mut().fail_commit = false;
        let mut restored = EditorCore::open(backend.clone()).await.unwrap();
        assert_eq!(restored.read(&id).unwrap().path, "b.md");
        restored.save(&id, None).await.unwrap();
        assert_eq!(backend.storage.borrow().files["b.md"], b"draft");
        assert!(!backend.storage.borrow().files.contains_key("a.md"));
        assert!(backend.storage.borrow().intent.is_none());
        restored.rename("b.md", "b.md").await.unwrap();
        restored.remove("b.md", false).await.unwrap();
        assert!(restored.read(&id).unwrap().deleted);
        assert!(restored.save(&id, None).await.is_err());
    });
}
#[test]
fn private_history_does_not_require_an_ordinary_directory() {
    block_on(async {
        let mut backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        replace(&mut core, &id, "draft").await;
        drop(core);
        backend.projection = false;
        let mut private = EditorCore::open(backend).await.unwrap();
        private.refresh(&id).await.unwrap();
        private.save(&id, None).await.unwrap();
        let state = private.read(&id).unwrap();
        assert_eq!(state.snapshot.text.as_ref(), "draft");
        assert!(state.dirty);
        assert!(state.autosave_delay.is_none());
        assert!(state.persisted_version.is_some());
        let mut preview = PreviewController::default();
        let source = private.document_source(&[]);
        assert_eq!(source.documents.len(), 1);
        assert!(source.snapshots.is_empty());
        preview.synchronize(&source, 1000);
        preview.subscribe(&id, "history-only", 1000).unwrap();
        let task = preview_task(&private, &mut preview, &id);
        assert_eq!(task.source, "draft");
        assert_eq!(private.read(&id).unwrap().undo, state.undo);
        assert!(private.take_mutations().is_empty());
    });
}

#[test]
fn undo_groups_follow_caller_gesture_ids_not_backend_time() {
    block_on(async {
        let backend = MemoryBackend::new(b"");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        for (text, group, elapsed) in [
            ("a", "gesture-1", 0),
            ("b", "gesture-1", 2000),
            ("c", "gesture-2", 2001),
        ] {
            backend.storage.borrow_mut().now = elapsed;
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
            .await
            .unwrap();
        }
        core.undo(&id).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "ab");
        core.undo(&id).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "");
        core.redo(&id).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "ab");
        core.redo(&id).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "abc");
    });
}

#[test]
fn documents_keep_separate_histories_and_reopen_without_reseeding() {
    block_on(async {
        let backend = MemoryBackend::new("A😀".as_bytes());
        backend
            .storage
            .borrow_mut()
            .files
            .insert("b.md".into(), b"B".to_vec());
        let mut core = EditorCore::open(backend).await.unwrap();
        let first = core.open_file("a.md").await.unwrap();
        let second = core.open_file("b.md").await.unwrap();
        assert_ne!(first, second);
        assert_ne!(
            core.read(&first).unwrap().snapshot.version.identity(),
            core.read(&second).unwrap().snapshot.version.identity()
        );
        core.edit(&first, [(5..5, "!")]).await.unwrap();
        let mutations = core.take_mutations();
        assert_eq!(mutations.len(), 1);
        assert_eq!(mutations[0].document.id, first);
        assert_eq!(mutations[0].document.snapshot.text.as_ref(), "A😀!");
        assert_eq!(core.read(&second).unwrap().snapshot.text.as_ref(), "B");
        assert_eq!(core.open_file("a.md").await.unwrap(), first);
        assert_eq!(core.read(&first).unwrap().snapshot.text.as_ref(), "A😀!");
    });
}

#[test]
fn adapter_delivers_accepted_history_failure_once() {
    block_on(async {
        use serde_json::json;
        let backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap();
        let mut adapter = EditorAdapter::default();
        backend.storage.borrow_mut().fail_commit = true;
        let value = adapter
            .call(
                &mut core,
                "apply",
                json!({"id":id,"command":{
                    "kind":"edit","base":before.snapshot.version,
                    "input":{"kind":"text","text":"draft"}
                }}),
            )
            .await
            .unwrap();
        assert_eq!(value, json!(id));
        let batch = adapter.take_mutations(&mut core).unwrap();
        assert_eq!(batch.len(), 1);
        let receipt = &batch[0];
        assert_eq!(receipt["document"]["snapshot"]["text"], "draft");
        assert_eq!(receipt["history"]["status"], "failed");
        assert!(receipt["document"]["persistenceError"].is_string());
        assert_eq!(
            receipt["document"]["persistedVersion"],
            serde_json::to_value(before.persisted_version).unwrap()
        );
        assert!(receipt["update"]["operation"].is_object());
        assert!(core.take_mutations().is_empty());

        backend.storage.borrow_mut().fail_commit = false;
        let recovered = adapter
            .call(&mut core, "retry_history", json!({"id":id}))
            .await
            .unwrap();
        assert_eq!(recovered["snapshot"], receipt["document"]["snapshot"]);
        assert_eq!(recovered["persistenceError"], json!(null));
        assert_eq!(
            recovered["persistedVersion"],
            recovered["snapshot"]["version"]
        );
        assert!(core.take_mutations().is_empty());
        assert_eq!(backend.storage.borrow().files["a.md"], b"old");
    });
}

#[test]
fn reopening_history_preserves_identity_but_not_peer_undo_or_preview_session() {
    block_on(async {
        let backend = MemoryBackend::new(b"disk");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap();
        let mut preview = PreviewController::default();
        preview.synchronize(&core.document_source(&[]), 1000);
        preview.subscribe(&id, "client", 1000).unwrap();
        let old = preview_task(&core, &mut preview, &id);
        backend
            .storage
            .borrow_mut()
            .files
            .insert("a.md".into(), "external 😀".as_bytes().to_vec());
        core.refresh(&id).await.unwrap();
        assert!(!core.read(&id).unwrap().undo.can_undo);
        preview.synchronize(&core.document_source(&[]), 1000);
        assert!(!preview.complete(preview_result(&old)));
        preview.retry(&id, 1000).unwrap();
        let external = preview_task(&core, &mut preview, &id);
        assert_eq!(external.source, "external 😀");
        replace(&mut core, &id, "external 😀!").await;
        assert!(core.read(&id).unwrap().undo.can_undo);
        let version = core.read(&id).unwrap().snapshot.version;
        drop(core);
        let restored = EditorCore::open(backend).await.unwrap();
        let after = restored.read(&id).unwrap();
        assert_eq!(after.snapshot.version, version);
        assert_eq!(
            before.snapshot.version.identity(),
            after.snapshot.version.identity()
        );
        assert_ne!(before.peer_id, after.peer_id);
        assert!(!after.undo.can_undo);
        assert_eq!(after.snapshot.text.as_ref(), "external 😀!");
        // A reopened editor is a new owner, even if its source epoch starts at zero.
        preview.clear();
        preview.synchronize(&restored.document_source(&[]), 1000);
        preview.subscribe(&id, "client", 1000).unwrap();
        let current = preview_task(&restored, &mut preview, &id);
        assert_ne!(current.ticket.task_id, external.ticket.task_id);
        assert!(!preview.complete(preview_result(&external)));
        assert!(preview.complete(preview_result(&current)));
    });
}

#[test]
fn lightweight_status_tracks_baselines_without_exposing_personal_state_or_text() {
    block_on(async {
        let backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let check = |core: &EditorCore<MemoryBackend>, expected: bool| {
            let status = core.status(&id).unwrap();
            let document = core.read(&id).unwrap();
            assert_eq!(status.dirty, expected);
            assert_eq!(
                status.dirty,
                document.snapshot.text.as_ref() != document.saved_content
            );
            assert_eq!(status.version, document.snapshot.version);
            let host = serde_json::to_value(core.host_document(&id, true).unwrap()).unwrap();
            for field in ["snapshot", "undo", "peerId", "autosaveDelay"] {
                assert!(host.get(field).is_none(), "host must not expose {field}");
            }
        };
        check(&core, false);
        replace(&mut core, &id, "draft").await;
        check(&core, true);
        core.save(&id, None).await.unwrap();
        check(&core, false);
        core.undo(&id).await.unwrap();
        check(&core, true);
        core.redo(&id).await.unwrap();
        check(&core, false);
        backend
            .storage
            .borrow_mut()
            .files
            .insert("a.md".into(), b"external".to_vec());
        core.refresh(&id).await.unwrap();
        check(&core, false);
        backend.storage.borrow_mut().fail_commit = true;
        replace(&mut core, &id, "uncommitted").await;
        check(&core, true);
    });
}
