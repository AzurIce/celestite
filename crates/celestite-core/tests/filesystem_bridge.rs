mod support;
use celestite_core::{
    editor::observation::ExternalChangeStatus,
    editor::{EditorCore, EditorOptions, ExternalChangePolicy, MAX_TEXT_BYTES},
    error::{EditorResult, ErrorCode},
};
use futures_lite::future::block_on;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use support::{TestFs, WriteFault, identity};

#[derive(Clone)]
struct Fixture {
    files: TestFs,
    recovery: TestFs,
}
impl Fixture {
    fn new(bytes: &[u8]) -> Self {
        Self {
            files: TestFs::with_file("a.md", bytes),
            recovery: TestFs::default(),
        }
    }
    fn external(&self, bytes: &[u8]) {
        self.files.put("a.md", bytes);
    }
    fn record(&self) -> Value {
        self.recovery
            .files()
            .iter()
            .find(|(path, _)| path.starts_with("recovery/") && path.ends_with(".json"))
            .map(|(_, bytes)| serde_json::from_slice(bytes).unwrap())
            .unwrap_or(Value::Null)
    }
}
async fn open_host(fixture: Fixture) -> EditorResult<EditorCore<TestFs>> {
    EditorCore::open_with_options(
        identity(),
        Some(fixture.files),
        Some(fixture.recovery),
        EditorOptions {
            external_changes: ExternalChangePolicy::Merge,
            clock: Arc::new(|| 1000),
            ..Default::default()
        },
    )
    .await
}
async fn open_deferred(fixture: Fixture) -> EditorCore<TestFs> {
    EditorCore::open_with_options(
        identity(),
        Some(fixture.files),
        Some(fixture.recovery),
        EditorOptions {
            external_changes: ExternalChangePolicy::Merge,
            defer_filesystem_diff: true,
            clock: Arc::new(|| 1000),
        },
    )
    .await
    .unwrap()
}
async fn edit(core: &mut EditorCore<TestFs>, id: &str, from: usize, to: usize, insert: &str) {
    core.edit(id, [(from..to, insert)]).unwrap();
}

#[test]
fn detached_observation_merges_into_newer_live_edits_and_keeps_personal_undo() {
    block_on(async {
        let backend = Fixture::new(b"A middle B");
        let mut core = open_deferred(backend.clone()).await;
        let id = core.open_file("a.md").await.unwrap();
        let peer_id = core.read(&id).unwrap().peer_id;
        backend.external(b"A1 middle B1");
        core.refresh(&id).await.unwrap();
        let task = core.take_file_observation().unwrap().unwrap();
        assert!(core.take_file_observation().unwrap().is_none());
        assert_eq!(
            core.read(&id).unwrap().status.external_change,
            Some(ExternalChangeStatus::Pending)
        );
        let error = core.save(&id, None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::FilesystemReconciliationPending);
        assert_eq!(backend.files.writes(), 0);
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
        assert!(state.status.external_change.is_none());
        core.undo(&id).unwrap();
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "A1 middle B1"
        );
        let before_refresh = core.status(&id).unwrap().version;
        core.refresh(&id).await.unwrap();
        assert_eq!(core.status(&id).unwrap().version, before_refresh);
        assert!(!core.has_file_observations());
    });
}

#[test]
fn changed_disk_invalidates_old_success_or_timeout_and_coalesces_one_latest_task() {
    block_on(async {
        for timeout in [false, true] {
            let backend = Fixture::new(b"base");
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

            let latest = core.take_file_observation().unwrap().unwrap();
            assert!(
                core.complete_file_observation(latest.compute())
                    .await
                    .unwrap()
            );
            assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "latest");
        }
    });
}

#[test]
fn advancing_disk_cursor_invalidates_detached_results() {
    block_on(async {
        let backend = Fixture::new(b"base\n");
        let mut core = open_deferred(backend.clone()).await;
        let id = core.open_file("a.md").await.unwrap();
        backend.external(b"next\n");
        core.refresh(&id).await.unwrap();
        let task = core.take_file_observation().unwrap().unwrap();
        backend.external(b"base\r\n");
        core.refresh(&id).await.unwrap();
        assert!(
            !core
                .complete_file_observation(task.compute())
                .await
                .unwrap()
        );
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "base\n");

        assert_eq!(core.read(&id).unwrap().saved_content, "base\n");
        assert_eq!(backend.files.bytes("a.md"), b"base\r\n");
    });
}

#[test]
fn timeout_backoff_preserves_history_and_retries_only_after_an_explicit_trigger() {
    block_on(async {
        let backend = Fixture::new(b"base");
        let now = Arc::new(AtomicU64::new(1000));
        let clock = now.clone();
        let mut core = EditorCore::open_with_options(
            identity(),
            Some(backend.files.clone()),
            Some(backend.recovery.clone()),
            EditorOptions {
                external_changes: ExternalChangePolicy::Merge,
                defer_filesystem_diff: true,
                clock: Arc::new(move || clock.load(Ordering::Relaxed)),
            },
        )
        .await
        .unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap().snapshot;
        backend.external(b"next");
        core.refresh(&id).await.unwrap();
        let task = core.take_file_observation().unwrap().unwrap();
        let error = core
            .complete_file_observation(task.compute_with_budget(std::time::Duration::ZERO))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::FilesystemDiffTimeout);
        assert_eq!(error.path, "a.md");
        assert_eq!(core.read(&id).unwrap().snapshot, before);

        assert_eq!(
            core.read(&id).unwrap().status.external_change,
            Some(ExternalChangeStatus::Failed {
                code: error.code,
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
            ErrorCode::FilesystemDiffTimeout
        );
        assert_eq!(backend.files.writes(), 0);
        now.store(30_999, Ordering::Relaxed);
        core.refresh(&id).await.unwrap();
        assert!(!core.has_file_observations());
        now.store(31_000, Ordering::Relaxed);
        core.refresh(&id).await.unwrap();
        let retry = core.take_file_observation().unwrap().unwrap();
        core.complete_file_observation(retry.compute_with_budget(std::time::Duration::ZERO))
            .await
            .unwrap_err();
        assert!(matches!(
            core.read(&id).unwrap().status.external_change,
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
            core.read(&id).unwrap().status.external_change,
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
        assert!(core.read(&id).unwrap().status.external_change.is_none());
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), "changed");
    });
}

#[test]
fn fine_diff_and_continuous_disk_branch_preserve_live_peer_and_personal_undo() {
    block_on(async {
        let backend = Fixture::new(b"A middle B");
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
            assert_ne!(
                state.status.saved_version.as_ref(),
                Some(&state.status.version)
            );
            assert_eq!(state.peer_id, peer_id);
            let before_refresh = core.status(&id).unwrap().version;
            core.refresh(&id).await.unwrap();
            assert_eq!(core.status(&id).unwrap().version, before_refresh);
        }
        core.undo(&id).unwrap();
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "A12 middle B12"
        );
    });
}

#[test]
fn observed_aba_and_restart_keep_disk_version_separate_from_merged_version() {
    block_on(async {
        let backend = Fixture::new(b"a");
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
        let before_reopen = core.status(&id).unwrap().version;
        core.checkpoint().await.unwrap();
        drop(core);
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.refresh(&id).await.unwrap();

        assert_ne!(
            core.status(&id).unwrap().version.identity(),
            before_reopen.identity()
        );
        assert_eq!(core.read(&id).unwrap().snapshot.text, merged);
        core.save(&id, None).await.unwrap();
        let saved = core.read(&id).unwrap();
        assert_eq!(
            saved.status.saved_version.as_ref(),
            Some(&saved.status.version)
        );
        assert_eq!(backend.files.bytes("a.md"), merged.as_bytes());
        assert!(backend.record().is_null());
        core.refresh(&id).await.unwrap();
    });
}

#[test]
fn format_only_changes_preserve_text_history_and_exact_mixed_line_endings() {
    block_on(async {
        let backend = Fixture::new(b"a\nb\nc\n");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap();
        let raw = "\u{feff}a\r\nb\nc\r\n".as_bytes();
        backend.external(raw);
        core.refresh(&id).await.unwrap();
        let after = core.read(&id).unwrap();
        assert_eq!(before.status.version, after.status.version);
        assert!(!after.undo.can_undo);

        assert!(
            backend.record().is_null(),
            "clean text needs no recovery snapshot"
        );
        assert!(after.bom);
        assert_eq!(after.line_ending, celestite_core::text::LineEnding::CrLf);
        drop(core);
        assert!(open_host(backend).await.is_ok());
    });
}

#[test]
fn prepared_write_proves_no_io_but_started_old_bytes_and_aba_remain_uncertain() {
    block_on(async {
        for fault in [1, 3] {
            let backend = Fixture::new(b"old");
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 0, 3, "new").await;
            backend.files.fault(if fault == 1 {
                WriteFault::Before
            } else {
                WriteFault::Reverted
            });
            assert!(core.save(&id, None).await.is_err());
            assert_eq!(backend.files.bytes("a.md"), b"old");
            drop(core);
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            core.refresh(&id).await.unwrap();
            let state = core.read(&id).unwrap();
            assert!(state.status.conflict);
            assert!(state.autosave_delay.is_none());
            assert!(core.save(&id, None).await.is_err());
            assert_eq!(backend.files.writes(), 1);
            let header = backend.record();
            assert!(header["pending_write"]["phase"] == "started");
            assert_eq!(header["baseline"]["bytes"], json!(b"old".as_slice()));
        }
        let backend = Fixture::new(b"old");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        edit(&mut core, &id, 0, 3, "new").await;
        let fail_number = backend.recovery.writes() + 2;
        backend.recovery.state.lock().unwrap().fail_write_number = Some(fail_number);
        assert!(core.save(&id, None).await.is_err());
        assert_eq!(backend.files.writes(), 0);
        assert!(backend.record()["pending_write"]["phase"] == "prepared");
        drop(core);
        backend.recovery.state.lock().unwrap().fail_write_number = None;
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.refresh(&id).await.unwrap();
        assert!(!core.read(&id).unwrap().status.conflict);
        assert!(backend.record()["pending_write"].is_null());
        core.save(&id, None).await.unwrap();
        assert_eq!(backend.files.bytes("a.md"), b"new");
    });
}

#[test]
fn backend_proof_of_no_write_allows_safe_retry_even_after_restart() {
    block_on(async {
        for restart in [false, true] {
            let backend = Fixture::new(b"old");
            let mut core = open_host(backend.clone()).await.unwrap();
            let mut id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 3, 3, " local").await;
            backend.files.fault(WriteFault::Untouched);
            assert!(core.save(&id, None).await.is_err());
            assert!(backend.record()["pending_write"]["phase"] == "prepared");
            if restart {
                drop(core);
                core = open_host(backend.clone()).await.unwrap();
                id = core.open_file("a.md").await.unwrap();
            }
            // A subsequent external save is still diffed against the last disk cursor.
            backend.external(b"external old");
            backend.files.fault(WriteFault::None);
            core.save(&id, None).await.unwrap();
            assert_eq!(backend.files.bytes("a.md"), b"external old local");
            assert!(backend.record()["pending_write"].is_null());
            assert_eq!(backend.files.writes(), 2);
        }
    });
}

#[test]
fn completed_write_recovers_receipt_but_a_third_disk_state_is_not_merged() {
    block_on(async {
        for third in [false, true] {
            let backend = Fixture::new(b"old");
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 0, 3, "new").await;
            backend.files.fault(WriteFault::After);
            assert!(core.save(&id, None).await.is_err());
            if third {
                backend.external(b"third");
            }
            drop(core);
            let mut core = open_host(backend.clone()).await.unwrap();
            let id = core.open_file("a.md").await.unwrap();
            core.refresh(&id).await.unwrap();
            let state = core.read(&id).unwrap();
            assert_eq!(state.snapshot.text.as_ref(), "new");
            assert_eq!(state.status.conflict, third);
            assert_eq!(!backend.record()["pending_write"].is_null(), third);
            assert_eq!(backend.files.writes(), 1);
        }
    });
}

#[test]
fn save_reconciles_disk_then_rejects_a_now_stale_requested_version() {
    block_on(async {
        let backend = Fixture::new(b"base");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        edit(&mut core, &id, 4, 4, " local").await;
        let version = core.read(&id).unwrap().status.version;
        backend.external(b"external base");
        assert_eq!(
            core.save(&id, Some(version)).await.unwrap_err().code,
            ErrorCode::StaleVersion
        );
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "external base local"
        );
        assert_eq!(backend.files.writes(), 0);
        let version = core.read(&id).unwrap().status.version;
        core.save(&id, Some(version)).await.unwrap();
        assert_eq!(backend.files.bytes("a.md"), b"external base local");
    });
}

#[test]
fn invalid_disk_content_keeps_the_committed_cursor_and_live_text() {
    block_on(async {
        let backend = Fixture::new(b"base");
        let mut core = open_host(backend.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        let before = core.read(&id).unwrap().snapshot;
        for bytes in [vec![0xff], vec![0], vec![b'a'; MAX_TEXT_BYTES + 1]] {
            backend.external(&bytes);
            let observed = core.observe_files(std::slice::from_ref(&id)).await.unwrap();
            assert!(observed[0].status.error.is_some());
            assert_eq!(core.read(&id).unwrap().snapshot, before);
            assert_eq!(core.read(&id).unwrap().saved_content, "base");
        }
    });
}

#[test]
fn unicode_disk_sequences_survive_restore_including_empty_noop_and_aba() {
    block_on(async {
        // Scalar diff combinations belong to buffer::filesystem's exhaustive
        // round-trip test; this layer checks plaintext restoration and a fresh baseline.
        for (scenario, initial, observations) in [
            ("empty and ABA", "", ["😀", ""]),
            ("combining and CJK", "e\u{301}", ["甲😀", "e\u{301}"]),
            ("no-op and deletion", "😀", ["😀", ""]),
        ] {
            let backend = Fixture::new(initial.as_bytes());
            let mut core = open_host(backend.clone()).await.unwrap();
            let mut id = core.open_file("a.md").await.unwrap();
            edit(&mut core, &id, 0, 0, "local ").await;
            for disk in observations {
                backend.external(disk.as_bytes());
                core.refresh(&id).await.unwrap();
                let before = core.read(&id).unwrap();
                assert_eq!(before.saved_content, disk, "{scenario}");
                core.checkpoint().await.unwrap();
                assert_eq!(
                    backend.record()["baseline"]["bytes"],
                    json!(disk.as_bytes()),
                    "{scenario}"
                );
                drop(core);
                core = open_host(backend.clone()).await.unwrap();
                id = core.open_file("a.md").await.unwrap();
                core.refresh(&id).await.unwrap();
                let restored = core.read(&id).unwrap();
                assert_eq!(restored.snapshot.text, before.snapshot.text, "{scenario}");
            }
        }
    });
}

#[test]
fn checkpoint_failure_keeps_the_external_merge_and_does_not_block_later_edits() {
    block_on(async {
        let fixture = Fixture::new(b"base");
        let mut core = open_host(fixture.clone()).await.unwrap();
        let id = core.open_file("a.md").await.unwrap();
        core.edit(&id, [(4..4, " local")]).unwrap();
        core.take_mutations();
        fixture.recovery.fail_writes(true);
        fixture.external(b"external base");
        assert_eq!(core.refresh(&id).await.unwrap_err().code, ErrorCode::Io);
        assert!(
            core.take_mutations()
                .iter()
                .any(|mutation| mutation.document.snapshot.text.as_ref() == "external base local")
        );
        let state = core.read(&id).unwrap();
        assert_eq!(state.snapshot.text.as_ref(), "external base local");
        assert!(state.status.recovery_error.is_some());
        core.edit(&id, [(0..0, "new ")]).unwrap();
        assert_eq!(
            core.read(&id).unwrap().snapshot.text.as_ref(),
            "new external base local"
        );
        fixture.recovery.fail_writes(false);
        core.checkpoint().await.unwrap();
        assert!(core.status(&id).unwrap().recovery_error.is_none());
        drop(core);
        let mut restored = open_host(fixture).await.unwrap();
        let id = restored.open_file("a.md").await.unwrap();
        assert_eq!(
            restored.read(&id).unwrap().snapshot.text.as_ref(),
            "new external base local"
        );
        assert!(!restored.read(&id).unwrap().undo.can_undo);
    });
}
