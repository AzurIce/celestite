use celestite_core::backend::{
    Backend, DirectoryIntent, DocumentHeader, EditorError, EditorResult, FileSnapshot,
    JournalEntry, StoredDocument, WritePhase,
};
use celestite_core::editor::observation::ExternalChangeStatus;
use celestite_core::editor::{EditorCore, EditorOptions, ExternalChangePolicy, MAX_TEXT_BYTES};
use celestite_core::instance::{InstanceIdentity, Vault};
use futures_lite::future::block_on;
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

#[derive(Default)]
struct State {
    now: u64,
    bytes: Vec<u8>,
    records: BTreeMap<String, StoredDocument>,
    attempts: Vec<(DocumentHeader, Option<JournalEntry>)>,
    fail_commit: bool,
    lose_receipt: bool,
    fail_started: bool,
    write_fault: u8,
    writes: usize,
}
#[derive(Clone)]
struct HostBackend {
    state: Rc<RefCell<State>>,
    identity: InstanceIdentity,
}
impl HostBackend {
    fn new(bytes: &[u8]) -> Self {
        Self {
            state: Rc::new(RefCell::new(State {
                bytes: bytes.into(),
                now: 1000,
                ..Default::default()
            })),
            identity: InstanceIdentity {
                instance_id: "host".into(),
                vault: Vault {
                    vault_id: "vault".into(),
                    history_id: "history".into(),
                },
            },
        }
    }
    fn external(&self, bytes: &[u8]) {
        self.state.borrow_mut().bytes = bytes.into();
    }
    fn header(&self, id: &str) -> DocumentHeader {
        self.state.borrow().records[id].0.clone()
    }
}
fn error() -> EditorError {
    EditorError::new("IO", "injected failure", "a.md")
}
fn revision(bytes: &[u8]) -> String {
    format!("{bytes:?}")
}
impl Backend for HostBackend {
    fn identity(&self) -> &InstanceIdentity {
        &self.identity
    }
    fn persistent(&self) -> bool {
        true
    }
    fn has_projection(&self) -> bool {
        true
    }
    fn now_ms(&self) -> u64 {
        self.state.borrow().now
    }
    fn new_id(&self) -> EditorResult<String> {
        static ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Ok(format!(
            "id-{}",
            ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }
    async fn load(&mut self) -> EditorResult<Vec<StoredDocument>> {
        Ok(self.state.borrow().records.values().cloned().collect())
    }
    async fn commit(
        &mut self,
        header: &DocumentHeader,
        entry: Option<&JournalEntry>,
    ) -> EditorResult<()> {
        let mut state = self.state.borrow_mut();
        state.attempts.push((header.clone(), entry.cloned()));
        if state.fail_commit
            || (state.fail_started
                && header
                    .pending_write
                    .as_ref()
                    .is_some_and(|p| p.phase == WritePhase::Started))
        {
            return Err(error());
        }
        let old = state.records.get(&header.id);
        let sequence = old.map_or(0, |r| r.0.sequence);
        if let Some(entry) = entry
            && sequence == header.sequence
        {
            assert_eq!(
                serde_json::to_value(old.unwrap().1.last().unwrap()).unwrap(),
                serde_json::to_value(entry).unwrap()
            );
        } else {
            assert_eq!(header.sequence, sequence + u64::from(entry.is_some()));
        }
        let record = state
            .records
            .entry(header.id.clone())
            .or_insert_with(|| (header.clone(), vec![]));
        if let Some(entry) = entry
            && record.1.len() < header.sequence as usize
        {
            record.1.push(entry.clone());
        }
        record.0 = header.clone();
        if std::mem::take(&mut state.lose_receipt) {
            return Err(error());
        }
        Ok(())
    }
    async fn directory_intent(&mut self) -> EditorResult<Option<DirectoryIntent>> {
        Ok(None)
    }
    async fn set_directory_intent(
        &mut self,
        _intent: Option<&DirectoryIntent>,
    ) -> EditorResult<()> {
        Ok(())
    }
    async fn read_file(&self, _path: &str, _limit: Option<u64>) -> EditorResult<FileSnapshot> {
        let data = self.state.borrow().bytes.clone();
        Ok(FileSnapshot {
            revision: revision(&data),
            data,
        })
    }
    async fn write_file(
        &self,
        _path: &str,
        data: &[u8],
        _mode: &str,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        let mut state = self.state.borrow_mut();
        state.writes += 1;
        assert_eq!(expected, Some(revision(&state.bytes).as_str()));
        let fault = state.write_fault;
        if fault == 1 || fault == 4 {
            let mut error = error();
            error.write_not_started = fault == 4;
            return Err(error);
        }
        let old = state.bytes.clone();
        state.bytes = data.into();
        if fault == 3 {
            state.bytes = old;
        }
        if fault >= 2 {
            return Err(error());
        }
        Ok(revision(data))
    }
}
async fn open_host(backend: HostBackend) -> EditorResult<EditorCore<HostBackend>> {
    EditorCore::open_with_options(
        backend,
        EditorOptions {
            external_changes: ExternalChangePolicy::Merge,
            ..Default::default()
        },
    )
    .await
}

async fn open_deferred(backend: HostBackend) -> EditorCore<HostBackend> {
    EditorCore::open_with_options(
        backend,
        EditorOptions {
            external_changes: ExternalChangePolicy::Merge,
            defer_filesystem_diff: true,
        },
    )
    .await
    .unwrap()
}

#[test]
fn detached_observation_merges_into_newer_live_edits_and_keeps_personal_undo() {
    block_on(async {
        let backend = HostBackend::new(b"A middle B");
        let mut core = open_deferred(backend.clone()).await;
        let id = core.open_file("a.md").await.unwrap();
        let peer_id = core.read(&id).unwrap().peer_id;
        backend.external(b"A1 middle B1");
        core.refresh(&id).await.unwrap();
        let task = core.take_file_observation().unwrap().unwrap();
        assert!(core.take_file_observation().unwrap().is_none());
        assert_eq!(
            core.read(&id).unwrap().external_change,
            Some(ExternalChangeStatus::Pending)
        );
        let error = core.save(&id, None).await.unwrap_err();
        assert_eq!(error.code, "FilesystemReconciliationPending");
        assert_eq!(backend.state.borrow().writes, 0);
        edit(&mut core, &id, 2, 8, "MIDDLE").await;
        assert!(
            core.complete_file_observation(task.compute())
                .await
                .unwrap()
        );
        let state = core.read(&id).unwrap();
        assert_eq!(state.snapshot.text.as_ref(), "A1 MIDDLE B1");
        assert_eq!(state.saved_content, "A1 middle B1");
        assert_eq!(state.peer_id, peer_id);
        assert!(state.external_change.is_none());
        core.undo(&id).await.unwrap();
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "A1 middle B1"
        );
        let sequence = backend.header(&id).sequence;
        core.refresh(&id).await.unwrap();
        assert!(!core.has_file_observations());
        assert_eq!(backend.header(&id).sequence, sequence);
    });
}

#[test]
fn changed_disk_invalidates_old_success_or_timeout_and_coalesces_one_latest_task() {
    block_on(async {
        for timeout in [false, true] {
            let backend = HostBackend::new(b"base");
            let mut core = open_deferred(backend.clone()).await;
            let id = core.open_file("a.md").await.unwrap();
            let before = core.read(&id).unwrap().snapshot;
            backend.external(b"first");
            core.refresh(&id).await.unwrap();
            let task = core.take_file_observation().unwrap().unwrap();
            backend.external(b"second");
            core.refresh(&id).await.unwrap();
            backend.external(b"latest");
            core.refresh(&id).await.unwrap();
            assert!(core.take_file_observation().unwrap().is_none());
            let result = if timeout {
                task.compute_with_budget(std::time::Duration::ZERO)
            } else {
                task.compute()
            };
            assert!(!core.complete_file_observation(result).await.unwrap());
            assert_eq!(core.read(&id).unwrap().snapshot, before);
            assert_eq!(backend.header(&id).sequence, 0);
            let latest = core.take_file_observation().unwrap().unwrap();
            assert!(
                core.complete_file_observation(latest.compute())
                    .await
                    .unwrap()
            );
            assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "latest");
            assert_eq!(backend.header(&id).sequence, 1);
        }
    });
}

#[test]
fn advancing_disk_cursor_invalidates_detached_results() {
    block_on(async {
        let backend = HostBackend::new(b"base\n");
        let mut core = open_deferred(backend.clone()).await;
        let id = core.open_file("a.md").await.unwrap();
        backend.external(b"next\n");
        core.refresh(&id).await.unwrap();
        let task = core.take_file_observation().unwrap().unwrap();
        backend.external(b"base\r\n");
        core.refresh(&id).await.unwrap();
        let cursor = backend.header(&id).disk_cursor.unwrap();
        assert_eq!(cursor.observation, 1);
        assert!(
            !core
                .complete_file_observation(task.compute())
                .await
                .unwrap()
        );
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "base\n");
        assert_eq!(backend.header(&id).sequence, 0);
        assert_eq!(backend.header(&id).disk_cursor.unwrap().bytes, b"base\r\n");
    });
}

#[test]
fn timeout_backoff_preserves_history_and_retries_only_after_an_explicit_trigger() {
    block_on(async {
        let backend = HostBackend::new(b"base");
        let mut core = open_deferred(backend.clone()).await;
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap().snapshot;
        backend.external(b"next");
        core.refresh(&id).await.unwrap();
        let task = core.take_file_observation().unwrap().unwrap();
        let error = core
            .complete_file_observation(task.compute_with_budget(std::time::Duration::ZERO))
            .await
            .unwrap_err();
        assert_eq!(error.code, "FilesystemDiffTimeout");
        assert_eq!(error.path, "a.md");
        assert_eq!(core.read(&id).unwrap().snapshot, before);
        assert_eq!(backend.header(&id).sequence, 0);
        assert_eq!(
            core.read(&id).unwrap().external_change,
            Some(ExternalChangeStatus::Failed {
                code: error.code.clone(),
                message: error.message.clone(),
                retry_at: 31_000,
            })
        );
        for _ in 0..10 {
            core.refresh(&id).await.unwrap();
        }
        assert!(!core.has_file_observations());
        assert_eq!(
            core.save(&id, None).await.unwrap_err().code,
            "FilesystemDiffTimeout"
        );
        assert_eq!(backend.state.borrow().writes, 0);
        backend.state.borrow_mut().now = 31_000;
        core.refresh(&id).await.unwrap();
        let retry = core.take_file_observation().unwrap().unwrap();
        core.complete_file_observation(retry.compute_with_budget(std::time::Duration::ZERO))
            .await
            .unwrap_err();
        assert!(matches!(
            core.read(&id).unwrap().external_change,
            Some(ExternalChangeStatus::Failed {
                retry_at: 91_000,
                ..
            })
        ));
        // A different observation bypasses the old input's backoff immediately.
        backend.external(b"changed");
        core.refresh(&id).await.unwrap();
        let changed = core.take_file_observation().unwrap().unwrap();
        core.complete_file_observation(changed.compute_with_budget(std::time::Duration::ZERO))
            .await
            .unwrap_err();
        assert!(matches!(
            core.read(&id).unwrap().external_change,
            Some(ExternalChangeStatus::Failed {
                retry_at: 61_000,
                ..
            })
        ));
        // A manual retry also bypasses backoff, this time for unchanged input.
        core.retry_file_observation(&id).await.unwrap();
        let retry = core.take_file_observation().unwrap().unwrap();
        core.complete_file_observation(retry.compute())
            .await
            .unwrap();
        assert!(core.read(&id).unwrap().external_change.is_none());
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "changed");
    });
}

async fn edit(core: &mut EditorCore<HostBackend>, id: &str, from: usize, to: usize, insert: &str) {
    core.edit(id, [(from..to, insert)]).await.unwrap();
}

#[test]
fn fine_diff_and_continuous_disk_branch_preserve_live_peer_and_personal_undo() {
    block_on(async {
        let backend = HostBackend::new(b"A middle B");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let peer_id = core.read(&id).unwrap().peer_id;
        edit(&mut core, &id, 2, 8, "MIDDLE").await;
        for (disk, expected) in [
            ("A1 middle B1", "A1 MIDDLE B1"),
            ("A12 middle B12", "A12 MIDDLE B12"),
        ] {
            backend.external(disk.as_bytes());
            core.refresh(&id).await.unwrap();
            let state = core.read(&id).unwrap();
            assert_eq!(state.snapshot.text.as_ref(), expected);
            assert_eq!(state.saved_content, disk);
            assert_ne!(state.saved_version.as_ref(), Some(&state.snapshot.version));
            assert_eq!(state.peer_id, peer_id);
            let sequence = backend.header(&id).sequence;
            core.refresh(&id).await.unwrap();
            assert_eq!(backend.header(&id).sequence, sequence);
        }
        core.undo(&id).await.unwrap();
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "A12 middle B12"
        );
    });
}

#[test]
fn observed_aba_and_restart_keep_disk_version_separate_from_merged_version() {
    block_on(async {
        let backend = HostBackend::new(b"a");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        edit(&mut core, &id, 0, 1, "X").await;
        for disk in [b"".as_slice(), b"a"] {
            backend.external(disk);
            core.refresh(&id).await.unwrap();
        }
        let merged = core.read(&id).unwrap().snapshot.text;
        assert!(
            merged.as_ref() == "Xa" || merged.as_ref() == "aX",
            "{merged}"
        );
        let sequence = backend.header(&id).sequence;
        drop(core);
        let mut core = open_host(backend.clone()).await.unwrap();
        core.refresh(&id).await.unwrap();
        assert_eq!(backend.header(&id).sequence, sequence);
        assert_eq!(core.read(&id).unwrap().snapshot.text, merged);
        core.save(&id, None).await.unwrap();
        let saved = core.read(&id).unwrap();
        assert_eq!(saved.saved_version.as_ref(), Some(&saved.snapshot.version));
        assert_eq!(
            backend.header(&id).disk_cursor.unwrap().bytes,
            merged.as_bytes()
        );
        core.refresh(&id).await.unwrap();
        assert_eq!(backend.header(&id).sequence, sequence);
    });
}

#[test]
fn failed_or_lost_commit_receipts_do_not_publish_and_retry_the_same_operation() {
    block_on(async {
        for lost in [false, true] {
            let backend = HostBackend::new(b"base");
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 4, 4, " local").await;
            let before = core.read(&id).unwrap();
            backend.external(b"external base");
            backend.state.borrow_mut().fail_commit = !lost;
            backend.state.borrow_mut().lose_receipt = lost;
            let attempt = backend.state.borrow().attempts.len();
            assert!(core.refresh(&id).await.is_err());
            let failed = core.read(&id).unwrap();
            assert_eq!(failed.snapshot, before.snapshot);
            assert_eq!(failed.saved_content, before.saved_content);
            assert_eq!(failed.saved_version, before.saved_version);
            assert!(failed.persistence_error.is_some());
            backend.state.borrow_mut().fail_commit = false;
            core.retry_history().await.unwrap();
            {
                let state = backend.state.borrow();
                let attempts = &state.attempts;
                assert_eq!(
                    serde_json::to_value(&attempts[attempt]).unwrap(),
                    serde_json::to_value(&attempts[attempt + 1]).unwrap()
                );
            }
            assert_eq!(
                core.read(&id).unwrap().snapshot.text.as_ref(),
                "external base local"
            );
            core.undo(&id).await.unwrap();
            assert_eq!(
                core.read(&id).unwrap().snapshot.text.as_ref(),
                "external base"
            );
        }
    });
}

#[test]
fn committed_observation_with_lost_receipt_recovers_after_process_restart() {
    block_on(async {
        let backend = HostBackend::new(b"base");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        backend.external(b"new base");
        backend.state.borrow_mut().lose_receipt = true;
        assert!(core.refresh(&id).await.is_err());
        drop(core);
        let mut core = open_host(backend.clone()).await.unwrap();
        let sequence = backend.header(&id).sequence;
        core.refresh(&id).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "new base");
        assert_eq!(backend.header(&id).sequence, sequence);
    });
}

#[test]
fn format_only_changes_preserve_text_history_and_exact_mixed_line_endings() {
    block_on(async {
        let backend = HostBackend::new(b"a\nb\nc\n");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap();
        let raw = "\u{feff}a\r\nb\nc\r\n".as_bytes();
        backend.external(raw);
        core.refresh(&id).await.unwrap();
        let after = core.read(&id).unwrap();
        assert_eq!(before.snapshot.version, after.snapshot.version);
        assert!(!after.undo.can_undo);
        assert_eq!(backend.header(&id).sequence, 0);
        assert_eq!(backend.header(&id).disk_cursor.unwrap().bytes, raw);
        assert!(after.bom);
        assert_eq!(after.line_ending, "\r\n");
        drop(core);
        assert!(open_host(backend).await.is_ok());
    });
}

#[test]
fn prepared_write_proves_no_io_but_started_old_bytes_and_aba_remain_uncertain() {
    block_on(async {
        for fault in [1, 3] {
            let backend = HostBackend::new(b"old");
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 0, 3, "new").await;
            backend.state.borrow_mut().write_fault = fault;
            assert!(core.save(&id, None).await.is_err());
            assert_eq!(backend.state.borrow().bytes, b"old");
            drop(core);
            let mut core = open_host(backend.clone()).await.unwrap();
            core.refresh(&id).await.unwrap();
            let state = core.read(&id).unwrap();
            assert!(state.conflict);
            assert!(state.autosave_delay.is_none());
            assert!(core.save(&id, None).await.is_err());
            assert_eq!(backend.state.borrow().writes, 1);
            let header = backend.header(&id);
            assert!(
                header
                    .pending_write
                    .as_ref()
                    .is_some_and(|p| p.phase == WritePhase::Started)
            );
            assert_eq!(header.disk_cursor.unwrap().bytes, b"old");
        }
        let backend = HostBackend::new(b"old");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        edit(&mut core, &id, 0, 3, "new").await;
        backend.state.borrow_mut().fail_started = true;
        assert!(core.save(&id, None).await.is_err());
        assert_eq!(backend.state.borrow().writes, 0);
        assert!(backend.header(&id).pending_write.unwrap().phase == WritePhase::Prepared);
        drop(core);
        backend.state.borrow_mut().fail_started = false;
        let mut core = open_host(backend.clone()).await.unwrap();
        core.refresh(&id).await.unwrap();
        assert!(!core.read(&id).unwrap().conflict);
        assert!(backend.header(&id).pending_write.is_none());
        core.save(&id, None).await.unwrap();
        assert_eq!(backend.state.borrow().bytes, b"new");
    });
}

#[test]
fn backend_proof_of_no_write_allows_safe_retry_even_after_restart() {
    block_on(async {
        for restart in [false, true] {
            let backend = HostBackend::new(b"old");
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 3, 3, " local").await;
            backend.state.borrow_mut().write_fault = 4;
            assert!(core.save(&id, None).await.is_err());
            assert!(backend.header(&id).pending_write.unwrap().phase == WritePhase::Prepared);
            if restart {
                drop(core);
                core = open_host(backend.clone()).await.unwrap();
            }
            // A subsequent external save is still diffed against the last disk cursor.
            backend.external(b"external old");
            backend.state.borrow_mut().write_fault = 0;
            core.save(&id, None).await.unwrap();
            assert_eq!(backend.state.borrow().bytes, b"external old local");
            assert!(backend.header(&id).pending_write.is_none());
            assert_eq!(backend.state.borrow().writes, 2);
        }
    });
}

#[test]
fn completed_write_recovers_receipt_but_a_third_disk_state_is_not_merged() {
    block_on(async {
        for third in [false, true] {
            let backend = HostBackend::new(b"old");
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 0, 3, "new").await;
            backend.state.borrow_mut().write_fault = 2;
            assert!(core.save(&id, None).await.is_err());
            if third {
                backend.external(b"third");
            }
            drop(core);
            let mut core = open_host(backend.clone()).await.unwrap();
            core.refresh(&id).await.unwrap();
            let state = core.read(&id).unwrap();
            assert_eq!(state.snapshot.text.as_ref(), "new");
            assert_eq!(state.conflict, third);
            assert_eq!(backend.header(&id).pending_write.is_some(), third);
            assert_eq!(backend.state.borrow().writes, 1);
        }
    });
}

#[test]
fn save_reconciles_disk_then_rejects_a_now_stale_requested_version() {
    block_on(async {
        let backend = HostBackend::new(b"base");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        edit(&mut core, &id, 4, 4, " local").await;
        let version = core.read(&id).unwrap().snapshot.version;
        backend.external(b"external base");
        assert_eq!(
            core.save(&id, Some(version)).await.unwrap_err().code,
            "StaleVersion"
        );
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "external base local"
        );
        assert_eq!(backend.state.borrow().writes, 0);
        let version = core.read(&id).unwrap().snapshot.version;
        core.save(&id, Some(version)).await.unwrap();
        assert_eq!(backend.state.borrow().bytes, b"external base local");
    });
}

#[test]
fn legacy_baseline_is_validated_and_adopted_without_creating_new_history() {
    block_on(async {
        let backend = HostBackend::new(b"base");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let original = core.read(&id).unwrap().snapshot;
        drop(core);
        backend
            .state
            .borrow_mut()
            .records
            .get_mut(&id)
            .unwrap()
            .0
            .disk_cursor = None;
        let mut core = open_host(backend.clone()).await.unwrap();
        core.refresh(&id).await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot, original);
        assert_eq!(backend.header(&id).sequence, 0);
        assert!(backend.header(&id).disk_cursor.is_some());
        drop(core);
        {
            let mut state = backend.state.borrow_mut();
            let header = &mut state.records.get_mut(&id).unwrap().0;
            header.disk_cursor = None;
            header.saved_version = None;
        }
        assert!(open_host(backend).await.is_err());
    });
}

#[test]
fn invalid_disk_content_keeps_the_committed_cursor_and_live_text() {
    block_on(async {
        let backend = HostBackend::new(b"base");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap().snapshot;
        for bytes in [vec![0xff], vec![0], vec![b'a'; MAX_TEXT_BYTES + 1]] {
            backend.external(&bytes);
            assert!(core.refresh(&id).await.is_err());
            assert_eq!(core.read(&id).unwrap().snapshot, before);
            assert_eq!(backend.header(&id).disk_cursor.unwrap().bytes, b"base");
        }
    });
}

#[test]
fn unicode_disk_sequences_survive_restore_including_empty_noop_and_aba() {
    block_on(async {
        // Scalar diff combinations belong to buffer::filesystem's exhaustive
        // round-trip test; this layer checks the persisted cursor and journal.
        for (scenario, initial, observations) in [
            ("empty and ABA", "", ["😀", ""]),
            ("combining and CJK", "e\u{301}", ["甲😀", "e\u{301}"]),
            ("no-op and deletion", "😀", ["😀", ""]),
        ] {
            let backend = HostBackend::new(initial.as_bytes());
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 0, 0, "local ").await;
            for disk in observations {
                backend.external(disk.as_bytes());
                core.refresh(&id).await.unwrap();
                let before = core.read(&id).unwrap();
                assert_eq!(before.saved_content, disk, "{scenario}");
                assert_eq!(
                    backend.header(&id).disk_cursor.unwrap().bytes,
                    disk.as_bytes(),
                    "{scenario}"
                );
                drop(core);
                core = open_host(backend.clone()).await.unwrap();
                core.refresh(&id).await.unwrap();
                let restored = core.read(&id).unwrap().snapshot;
                assert_eq!(
                    (restored.version, restored.text),
                    (before.snapshot.version, before.snapshot.text),
                    "{scenario}"
                );
            }
        }
    });
}
