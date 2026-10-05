use celestite_core::*;
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
fn preview_rename_and_deletion_revoke_tasks_even_without_a_text_change() {
    block_on(async {
        let backend = MemoryBackend::new(b"body");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.subscribe_preview(&id, "client").unwrap();
        let old = core.take_preview_task(&id).unwrap().unwrap();
        core.rename("a.md", "moved.md").await.unwrap();
        let state = core.preview_state(&id).unwrap();
        assert_eq!(state.target.version, old.ticket.version);
        assert_eq!(state.target.path, "moved.md");
        assert!(!core.complete_preview(preview_result(&old)));
        core.retry_preview(&id).unwrap();
        let moved = core.take_preview_task(&id).unwrap().unwrap();
        assert_eq!(moved.ticket.path, "moved.md");
        core.remove("moved.md", false).await.unwrap();
        assert!(!core.complete_preview(preview_result(&moved)));
        assert!(core.preview_state(&id).is_err());
        assert!(core.read(&id).unwrap().deleted);
        assert_eq!(core.read(&id).unwrap().snapshot.text, "body");
        backend
            .storage
            .borrow_mut()
            .files
            .insert("moved.md".into(), b"new file".into());
        let new_id = core.open_file("moved.md").await.unwrap();
        assert_ne!(id, new_id);
        core.subscribe_preview(&new_id, "client").unwrap();
        assert!(!core.complete_preview(preview_result(&moved)));
        assert_eq!(
            core.take_preview_task(&new_id).unwrap().unwrap().source,
            "new file"
        );
    });
}

#[test]
fn external_reload_and_runtime_reopen_cannot_accept_old_preview_tickets() {
    block_on(async {
        let backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.subscribe_preview(&id, "client").unwrap();
        let old = core.take_preview_task(&id).unwrap().unwrap();
        backend
            .storage
            .borrow_mut()
            .files
            .insert("a.md".into(), b"external".into());
        core.refresh(&id).await.unwrap();
        assert!(!core.complete_preview(preview_result(&old)));
        core.retry_preview(&id).unwrap();
        let external = core.take_preview_task(&id).unwrap().unwrap();
        assert_eq!(external.source, "external");
        drop(core);
        let mut reopened = EditorCore::open(backend).await.unwrap();
        reopened.subscribe_preview(&id, "client").unwrap();
        let current = reopened.take_preview_task(&id).unwrap().unwrap();
        assert_ne!(current.ticket.task_id, external.ticket.task_id);
        assert!(!reopened.complete_preview(preview_result(&external)));
        assert!(reopened.complete_preview(preview_result(&current)));
    });
}

#[test]
fn accepted_draft_remains_previewable_when_history_commit_fails() {
    block_on(async {
        let backend = MemoryBackend::new(b"saved");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let version = core.read(&id).unwrap().snapshot.version;
        backend.storage.borrow_mut().fail_commit = true;
        core.edit(
            &id,
            version,
            vec![TextEdit {
                from: 0,
                to: 5,
                insert: "accepted draft".into(),
            }],
            SelectionContext::default(),
            "input.replace".into(),
        )
        .await
        .unwrap();
        assert!(core.read(&id).unwrap().persistence_error.is_some());
        core.subscribe_preview(&id, "client").unwrap();
        let task = core.take_preview_task(&id).unwrap().unwrap();
        assert_eq!(task.source, "accepted draft");
        assert!(core.complete_preview(preview_result(&task)));
        assert_eq!(backend.storage.borrow().files["a.md"], b"saved");
        assert!(core.read(&id).unwrap().dirty);
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
    let current = core.read(id).unwrap();
    core.edit(
        id,
        current.snapshot.version,
        vec![TextEdit {
            from: 0,
            to: current.snapshot.text.encode_utf16().count(),
            insert: text.into(),
        }],
        SelectionContext::default(),
        "input.paste".into(),
    )
    .await
    .unwrap();
}

#[test]
fn history_failure_keeps_accepted_draft_blocks_more_edits_and_can_retry() {
    block_on(async {
        let backend = MemoryBackend::new(b"old");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let durable = core.read(&id).unwrap().durable_version;
        backend.storage.borrow_mut().fail_commit = true;
        replace(&mut core, &id, "draft").await;
        let state = core.read(&id).unwrap();
        assert_eq!(state.snapshot.text, "draft");
        assert_eq!(state.durable_version, durable);
        assert!(
            state
                .persistence_error
                .unwrap()
                .contains("编辑历史尚未持久化")
        );
        assert!(core.undo(&id, UndoContext::default(), false).await.is_err());
        assert_eq!(backend.storage.borrow().files["a.md"], b"old");
        backend.storage.borrow_mut().fail_commit = false;
        core.retry_history().await.unwrap();
        assert_eq!(
            core.read(&id).unwrap().durable_version,
            Some(core.read(&id).unwrap().snapshot.version)
        );
        core.undo(&id, UndoContext::default(), false).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text, "old");
        core.undo(&id, UndoContext::default(), true).await.unwrap();
        core.save(&id, None).await.unwrap();
        drop(core);
        let restored = EditorCore::open(backend).await.unwrap();
        assert_eq!(restored.read(&id).unwrap().snapshot.text, "draft");
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
        assert_eq!(state.durable_version, Some(version));
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
        assert_eq!(core.read(&id).unwrap().snapshot.text, "draft\n");
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
        assert_eq!(state.snapshot.text, "external again");
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
        assert_eq!(state.snapshot.text, "draft");
        assert!(state.dirty);
        assert!(state.autosave_delay.is_none());
        assert!(state.durable_version.is_some());
    });
}

#[test]
fn vim_undo_groups_follow_commands_and_insert_sessions_instead_of_timeouts() {
    block_on(async {
        let backend = MemoryBackend::new(b"");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        for (text, group, elapsed) in [
            ("a", "input.vim.insert-1", 0),
            ("b", "input.vim.insert-1", 2000),
            ("c", "input.vim.insert-2", 2001),
        ] {
            backend.storage.borrow_mut().now = elapsed;
            let state = core.read(&id).unwrap().snapshot;
            let end = state.text.encode_utf16().count();
            core.edit(
                &id,
                state.version,
                vec![TextEdit {
                    from: end,
                    to: end,
                    insert: text.into(),
                }],
                SelectionContext::default(),
                group.into(),
            )
            .await
            .unwrap();
        }
        core.undo(&id, UndoContext::default(), false).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text, "ab");
        core.undo(&id, UndoContext::default(), false).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text, "");
        core.undo(&id, UndoContext::default(), true).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text, "ab");
        core.undo(&id, UndoContext::default(), true).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text, "abc");
    });
}

#[test]
fn serialized_service_isolates_documents_and_rejects_stale_edits() {
    block_on(async {
        use serde_json::json;
        let backend = MemoryBackend::new("A😀".as_bytes());
        backend
            .storage
            .borrow_mut()
            .files
            .insert("b.md".into(), b"B".to_vec());
        let mut core = EditorCore::open(backend).await.unwrap();
        let first = core
            .execute_service("open", json!({"path":"a.md"}))
            .await
            .unwrap();
        let second = core
            .execute_service("open", json!({"path":"b.md"}))
            .await
            .unwrap();
        let command = json!({"id":first["id"],"version":first["snapshot"]["version"],
            "edits":[{"from":3,"to":3,"insert":"!"}],"context":{"ranges":[{"anchor":3,"head":3}],"mainIndex":0},"userEvent":"input.type"});
        let result = core.execute_service("edit", command.clone()).await.unwrap();
        assert_eq!(result["document"]["snapshot"]["text"], "A😀!");
        assert_eq!(
            core.execute_service("edit", command)
                .await
                .unwrap_err()
                .code,
            "StaleVersion"
        );
        let other = core
            .execute_service("read", json!({"id":second["id"]}))
            .await
            .unwrap();
        assert_eq!(other["snapshot"]["text"], "B");
        let reopened = core
            .execute_service("open", json!({"path":"a.md"}))
            .await
            .unwrap();
        assert_eq!(reopened["id"], first["id"]);
        assert_eq!(reopened["snapshot"]["text"], "A😀!");
    });
}

#[test]
fn restart_allocates_fresh_writer_and_external_changes_are_not_personal_undo() {
    block_on(async {
        let backend = MemoryBackend::new(b"disk");
        let mut core = EditorCore::open(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap();
        backend
            .storage
            .borrow_mut()
            .files
            .insert("a.md".into(), "external 😀".as_bytes().to_vec());
        core.refresh(&id).await.unwrap();
        assert!(!core.read(&id).unwrap().undo.can_undo);
        replace(&mut core, &id, "external 😀!").await;
        core.undo(&id, UndoContext::default(), false).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text, "external 😀");
        let version = core.read(&id).unwrap().snapshot.version;
        drop(core);
        let restored = EditorCore::open(backend).await.unwrap();
        let after = restored.read(&id).unwrap();
        assert_eq!(after.snapshot.version, version);
        assert_eq!(
            before.snapshot.version.identity,
            after.snapshot.version.identity
        );
        assert_ne!(before.writer_id, after.writer_id);
        assert!(!after.undo.can_undo);
    });
}
