#![cfg(all(feature = "native", not(target_arch = "wasm32")))]
mod support;
use celestite_core::{
    editor::{EditorCore, EditorOptions, ExternalChangePolicy, MAX_FILE_BYTES, MAX_TEXT_BYTES},
    error::ErrorCode,
    fs::native::FsVault,
};
use futures_lite::future::block_on;
use serde_json::{Value, json};
use std::{fs, path::Path};
use support::identity;

async fn open(files: &Path, recovery: &Path) -> EditorCore<FsVault> {
    EditorCore::open_with_options(
        identity(),
        Some(FsVault::open(files).unwrap()),
        Some(FsVault::open_private(recovery).unwrap()),
        EditorOptions {
            external_changes: ExternalChangePolicy::Merge,
            ..Default::default()
        },
    )
    .await
    .unwrap()
}
fn drafts(root: &Path) -> Vec<(std::path::PathBuf, Value)> {
    fs::read_dir(root.join("recovery"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            (path, value)
        })
        .collect()
}

const EMPTY_DRAFT: &str = "recovery/00000000-0000-4000-8000-000000000000.json";

#[test]
fn maximum_lf_body_with_crlf_and_bom_can_save_reopen_and_restore_a_later_draft() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir_all(&files).unwrap();
        fs::write(files.join("a.md"), "\u{feff}seed\r\n").unwrap();
        let mut core = open(&files, &recovery).await;
        let id = core.open_file("a.md").await.unwrap();
        let body = "\n".repeat(MAX_TEXT_BYTES);
        core.edit(&id, [(0..5, body.as_str())]).unwrap();
        core.save(&id, None).await.unwrap();
        assert_eq!(
            fs::metadata(files.join("a.md")).unwrap().len(),
            MAX_FILE_BYTES as u64
        );
        assert!(!core.read(&id).unwrap().status.dirty);
        drop(core);

        let mut core = open(&files, &recovery).await;
        let id = core.open_file("a.md").await.unwrap();
        assert_eq!(core.read(&id).unwrap().snapshot.text.as_ref(), body);
        core.edit(&id, [(0..1, "")]).unwrap();
        core.checkpoint().await.unwrap();
        drop(core);

        let mut core = open(&files, &recovery).await;
        let restored_id = core.open_file("a.md").await.unwrap();
        let restored = core.read(&restored_id).unwrap();
        assert_ne!(restored_id, id);
        assert_eq!(restored.snapshot.text.len(), MAX_TEXT_BYTES - 1);
        assert_eq!(restored.saved_content, body);
        assert!(restored.status.dirty && restored.bom);
        assert_eq!(restored.line_ending, celestite_core::text::LineEnding::CrLf);
        assert!(!restored.undo.can_undo);
        core.save(&restored_id, None).await.unwrap();
        assert_eq!(
            fs::metadata(files.join("a.md")).unwrap().len(),
            (MAX_FILE_BYTES - 2) as u64
        );
    });
}

fn write_empty_recovery_stubs(root: &Path, subset: u8) {
    fs::create_dir_all(root.join("recovery")).unwrap();
    for (index, path) in ["recovery-format.json", "directory-intent.json", EMPTY_DRAFT]
        .into_iter()
        .enumerate()
    {
        if subset & (1 << index) != 0 {
            fs::write(root.join(path), []).unwrap();
        }
    }
}

#[test]
fn first_open_ignores_every_combination_of_empty_unpublished_recovery_files() {
    block_on(async {
        for subset in 1..=7 {
            let root = tempfile::tempdir().unwrap();
            let files = root.path().join("files");
            let recovery = root.path().join("private");
            fs::create_dir_all(files.join("old")).unwrap();
            fs::write(files.join("old/a.not"), "base").unwrap();
            write_empty_recovery_stubs(&recovery, subset);

            let mut core = open(&files, &recovery).await;
            assert!(core.resident().unwrap().is_empty(), "subset {subset}");
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &fs::read(recovery.join("recovery-format.json")).unwrap()
                )
                .unwrap(),
                json!(1),
                "subset {subset}"
            );
            core.close().await.unwrap();
            drop(core);

            let reopened = open(&files, &recovery).await;
            assert!(reopened.resident().unwrap().is_empty(), "subset {subset}");
            assert_eq!(fs::read(files.join("old/a.not")).unwrap(), b"base");
            assert!(!files.join("new").exists());
            if subset & 4 != 0 {
                assert!(fs::read(recovery.join(EMPTY_DRAFT)).unwrap().is_empty());
            }
        }
    });
}

#[test]
fn empty_unpublished_recovery_files_preserve_valid_drafts_and_start_fresh_histories() {
    block_on(async {
        for subset in 1..=7 {
            let root = tempfile::tempdir().unwrap();
            let files = root.path().join("files");
            let recovery = root.path().join("private");
            fs::create_dir_all(files.join("old")).unwrap();
            fs::write(files.join("old/a.not"), "base\r\n").unwrap();
            let mut core = open(&files, &recovery).await;
            let id = core.open_file("old/a.not").await.unwrap();
            core.replace_text(&id, "unsaved draft\n").unwrap();
            let previous = core.status(&id).unwrap().version;
            core.close().await.unwrap();
            drop(core);
            let draft_path = drafts(&recovery)[0].0.clone();
            let original_draft = fs::read(&draft_path).unwrap();
            assert_ne!(draft_path, recovery.join(EMPTY_DRAFT));
            write_empty_recovery_stubs(&recovery, subset);

            let mut restored = open(&files, &recovery).await;
            let documents = restored.resident().unwrap();
            assert_eq!(documents.len(), 1, "subset {subset}");
            let document = &documents[0];
            assert_ne!(document.status.id, id);
            assert_ne!(
                document.status.version.identity().history_id,
                previous.identity().history_id
            );
            assert_eq!(document.status.path, "old/a.not");
            assert_eq!(document.snapshot.text.as_ref(), "unsaved draft\n");
            assert_eq!(document.saved_content, "base\n");
            assert!(document.status.dirty);
            assert!(!document.undo.can_undo);
            assert_eq!(
                serde_json::from_slice::<Value>(
                    &fs::read(recovery.join("recovery-format.json")).unwrap()
                )
                .unwrap(),
                json!(1),
                "subset {subset}"
            );
            restored.close().await.unwrap();
            assert_eq!(fs::read(&draft_path).unwrap(), original_draft);
            assert_eq!(fs::read(files.join("old/a.not")).unwrap(), b"base\r\n");
            assert!(!files.join("new").exists());
            if subset & 4 != 0 {
                assert!(fs::read(recovery.join(EMPTY_DRAFT)).unwrap().is_empty());
            }
        }
    });
}

#[test]
fn plaintext_drafts_restore_with_fresh_crdt_identity_and_exact_saved_encoding() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::write(files.join("a.not"), "\u{feff}base\r\n").unwrap();
        let mut previous = None;
        for round in 0..4 {
            let mut core = open(&files, &recovery).await;
            let id = core.open_file("a.not").await.unwrap();
            let state = core.read(&id).unwrap();
            if let Some(version) = &previous {
                assert_ne!(state.status.version.identity(), version);
                assert!(!state.undo.can_undo);
                assert_eq!(state.snapshot.text.as_ref(), "draft base\n");
                assert_eq!(state.saved_content, "base\n");
                assert!(state.bom);
                assert_eq!(state.line_ending, celestite_core::text::LineEnding::CrLf);
            } else {
                core.replace_text(&id, "draft base\n").unwrap();
            }
            previous = Some(core.status(&id).unwrap().version.identity().clone());
            core.close().await.unwrap();
            drop(core);
            assert_eq!(
                fs::read(files.join("a.not")).unwrap(),
                "\u{feff}base\r\n".as_bytes()
            );
            let entries = drafts(&recovery);
            assert_eq!(entries.len(), 1);
            let draft = &entries[0].1;
            assert_eq!(draft["schema"], 1);
            assert_eq!(draft["path"], "a.not");
            assert_eq!(draft["text"], "draft base\n");
            assert_eq!(
                draft["baseline"]["bytes"],
                json!("\u{feff}base\r\n".as_bytes())
            );
            for key in [
                "id", "identity", "version", "seed", "packet", "journal", "sequence", "clocks",
            ] {
                assert!(
                    draft.get(key).is_none(),
                    "unexpected CRDT field {key}: {draft}"
                );
            }
            assert!(!recovery.join("documents").exists());
            if round == 3 {
                let mut core = open(&files, &recovery).await;
                let id = core.open_file("a.not").await.unwrap();
                core.save(&id, None).await.unwrap();
                assert_eq!(
                    fs::read(files.join("a.not")).unwrap(),
                    "\u{feff}draft base\r\n".as_bytes()
                );
                core.close().await.unwrap();
                assert!(
                    drafts(&recovery).is_empty(),
                    "clean files need no persisted CRDT or draft"
                );
            }
        }
    });
}

#[test]
fn recovery_keeps_raw_mixed_line_ending_baselines_for_both_change_policies() {
    block_on(async {
        for policy in [ExternalChangePolicy::Conflict, ExternalChangePolicy::Merge] {
            let root = tempfile::tempdir().unwrap();
            let files = root.path().join("files");
            let recovery = root.path().join("private");
            fs::create_dir(&files).unwrap();
            let original = "\u{feff}a\r\nb\nc\r\n".as_bytes();
            fs::write(files.join("a.not"), original).unwrap();
            let mut previous = None;
            for _ in 0..2 {
                let mut core = EditorCore::open_with_options(
                    identity(),
                    Some(FsVault::open(&files).unwrap()),
                    Some(FsVault::open_private(&recovery).unwrap()),
                    EditorOptions {
                        external_changes: policy,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                let id = core.open_file("a.not").await.unwrap();
                if let Some(version) = previous {
                    let state = core.read(&id).unwrap();
                    assert_ne!(state.status.version.identity(), &version);
                    assert_eq!(state.snapshot.text.as_ref(), "local a\nb\nc\n");
                    assert_eq!(state.saved_content, "a\nb\nc\n");
                    assert!(state.bom);
                    assert!(!state.status.conflict);
                    assert!(!state.undo.can_undo);
                } else {
                    core.edit(&id, [(0..0, "local ")]).unwrap();
                }
                previous = Some(core.status(&id).unwrap().version.identity().clone());
                core.close().await.unwrap();
                drop(core);
                let entries = drafts(&recovery);
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].1["baseline"]["bytes"], json!(original));
                assert_eq!(fs::read(files.join("a.not")).unwrap(), original);
            }
        }
    });
}

#[test]
fn restored_text_rebuilds_a_baseline_before_merging_new_disk_changes() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::write(files.join("a.not"), "base\r\n").unwrap();
        let mut core = open(&files, &recovery).await;
        let id = core.open_file("a.not").await.unwrap();
        core.edit(&id, [(0..0, "local ")]).unwrap();
        let old = core.status(&id).unwrap().version;
        core.close().await.unwrap();
        drop(core);
        fs::write(files.join("a.not"), "base external\r\n").unwrap();
        let mut core = open(&files, &recovery).await;
        let id = core.open_file("a.not").await.unwrap();
        let restored = core.read(&id).unwrap();
        assert_ne!(restored.status.version.identity(), old.identity());
        assert_eq!(restored.snapshot.text.as_ref(), "local base external\n");
        assert_eq!(restored.saved_content, "base external\n");
        assert!(!restored.undo.can_undo);
        core.save(&id, None).await.unwrap();
        assert_eq!(
            fs::read(files.join("a.not")).unwrap(),
            b"local base external\r\n"
        );
    });
}

#[test]
fn deleted_draft_and_recreated_active_path_restore_as_separate_documents() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::write(files.join("a.not"), "old base").unwrap();
        let mut core = open(&files, &recovery).await;
        let old_id = core.open_file("a.not").await.unwrap();
        core.replace_text(&old_id, "deleted draft").unwrap();
        core.remove("a.not", false).await.unwrap();
        assert!(core.status(&old_id).unwrap().deleted);
        fs::write(files.join("a.not"), "new base").unwrap();
        let active_id = core.open_file("a.not").await.unwrap();
        assert_ne!(old_id, active_id);
        core.replace_text(&active_id, "active draft").unwrap();
        core.close().await.unwrap();
        drop(core);

        let mut restored = open(&files, &recovery).await;
        let documents = restored.resident().unwrap();
        assert_eq!(documents.len(), 2);
        let deleted = documents
            .iter()
            .find(|document| document.status.deleted)
            .unwrap();
        let active = documents
            .iter()
            .find(|document| !document.status.deleted)
            .unwrap();
        assert_eq!(deleted.status.path, "a.not");
        assert_eq!(active.status.path, "a.not");
        assert_eq!(deleted.snapshot.text.as_ref(), "deleted draft");
        assert_eq!(active.snapshot.text.as_ref(), "active draft");
        assert_ne!(deleted.status.id, old_id);
        assert_ne!(active.status.id, active_id);
        assert_eq!(restored.open_file("a.not").await.unwrap(), active.status.id);
        restored.save(&active.status.id, None).await.unwrap();
        assert_eq!(fs::read(files.join("a.not")).unwrap(), b"active draft");
        assert_eq!(
            restored
                .read(&deleted.status.id)
                .unwrap()
                .snapshot
                .text
                .as_ref(),
            "deleted draft"
        );
    });
}

#[test]
fn removing_a_saved_file_does_not_retain_a_clean_deleted_recovery_snapshot() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::write(files.join("a.not"), "base").unwrap();
        let mut core = open(&files, &recovery).await;
        let id = core.open_file("a.not").await.unwrap();
        core.replace_text(&id, "draft to save before deletion")
            .unwrap();
        core.checkpoint().await.unwrap();
        assert_eq!(drafts(&recovery).len(), 1);

        core.file_remove("a.not", false).await.unwrap();
        let removed = core.read(&id).unwrap();
        assert!(removed.status.deleted);
        assert!(!removed.status.dirty);
        assert_eq!(removed.saved_content, "draft to save before deletion");
        assert!(!files.join("a.not").exists());
        assert!(drafts(&recovery).is_empty());
        core.close().await.unwrap();
        drop(core);
        assert!(drafts(&recovery).is_empty());
        let restored = open(&files, &recovery).await;
        assert!(restored.resident().unwrap().is_empty());
    });
}

#[test]
fn renaming_a_recreated_path_leaves_the_deleted_draft_at_its_original_path() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::write(files.join("a.not"), "old base").unwrap();
        let mut core = open(&files, &recovery).await;
        let old_id = core.open_file("a.not").await.unwrap();
        core.replace_text(&old_id, "deleted draft").unwrap();
        core.remove("a.not", false).await.unwrap();
        fs::write(files.join("a.not"), "new base").unwrap();
        let active_id = core.open_file("a.not").await.unwrap();
        core.replace_text(&active_id, "active draft").unwrap();

        core.rename("a.not", "b.not").await.unwrap();
        assert_eq!(core.status(&old_id).unwrap().path, "a.not");
        assert!(core.status(&old_id).unwrap().deleted);
        assert_eq!(core.status(&active_id).unwrap().path, "b.not");
        assert!(!core.status(&active_id).unwrap().deleted);
        assert!(!files.join("a.not").exists());
        assert_eq!(fs::read(files.join("b.not")).unwrap(), b"new base");
        core.close().await.unwrap();
        drop(core);

        let mut restored = open(&files, &recovery).await;
        let documents = restored.resident().unwrap();
        assert_eq!(documents.len(), 2);
        let deleted = documents
            .iter()
            .find(|document| document.status.deleted)
            .unwrap();
        let active = documents
            .iter()
            .find(|document| !document.status.deleted)
            .unwrap();
        assert_eq!(deleted.status.path, "a.not");
        assert_eq!(deleted.snapshot.text.as_ref(), "deleted draft");
        assert_eq!(active.status.path, "b.not");
        assert_eq!(active.snapshot.text.as_ref(), "active draft");
        assert_eq!(restored.open_file("b.not").await.unwrap(), active.status.id);
    });
}

#[test]
fn checkpoint_io_failure_keeps_edits_and_retries_without_writing_the_projection() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::write(files.join("a.not"), "base").unwrap();
        let mut core = open(&files, &recovery).await;
        let id = core.open_file("a.not").await.unwrap();
        let directory = recovery.join("recovery");
        let held = recovery.join("held-drafts");
        fs::rename(&directory, &held).unwrap();
        fs::write(&directory, "blocked directory").unwrap();
        for text in ["draft", "newest draft"] {
            let mutation = core.replace_text(&id, text).unwrap();
            assert_eq!(mutation.document.snapshot.text.as_ref(), text);
            assert!(core.checkpoint().await.is_err());
            assert!(core.status(&id).unwrap().recovery_error.is_some());
        }
        assert!(core.save(&id, None).await.is_err());
        assert!(core.close().await.is_err());
        assert_eq!(fs::read(files.join("a.not")).unwrap(), b"base");
        fs::remove_file(&directory).unwrap();
        fs::rename(&held, &directory).unwrap();
        core.checkpoint().await.unwrap();
        core.close().await.unwrap();
        drop(core);
        let mut restored = open(&files, &recovery).await;
        let id = restored.open_file("a.not").await.unwrap();
        assert_eq!(
            restored.read(&id).unwrap().snapshot.text.as_ref(),
            "newest draft"
        );
        assert!(restored.status(&id).unwrap().recovery_error.is_none());
    });
}

#[test]
fn malformed_recovery_is_reported_without_replacing_the_existing_snapshot() {
    block_on(async {
        for target in ["recovery-format.json", "directory-intent.json", "draft"] {
            for malformed in ["broken plaintext checkpoint", " \n"] {
                let root = tempfile::tempdir().unwrap();
                let files = root.path().join("files");
                let recovery = root.path().join("private");
                fs::create_dir(&files).unwrap();
                fs::write(files.join("a.not"), "base").unwrap();
                let mut core = open(&files, &recovery).await;
                let id = core.open_file("a.not").await.unwrap();
                core.replace_text(&id, "draft").unwrap();
                core.close().await.unwrap();
                drop(core);
                let draft_path = drafts(&recovery)[0].0.clone();
                let original_draft = fs::read(&draft_path).unwrap();
                let path = if target == "draft" {
                    draft_path.clone()
                } else {
                    recovery.join(target)
                };
                fs::write(&path, malformed).unwrap();
                let error = EditorCore::open(
                    identity(),
                    Some(FsVault::open(&files).unwrap()),
                    Some(FsVault::open_private(&recovery).unwrap()),
                )
                .await
                .err()
                .unwrap();
                assert_eq!(error.code, ErrorCode::Io, "{target}: {malformed:?}");
                assert_eq!(
                    error.path,
                    path.strip_prefix(&recovery).unwrap().to_str().unwrap()
                );
                assert_eq!(fs::read_to_string(&path).unwrap(), malformed);
                if target != "draft" {
                    assert_eq!(fs::read(&draft_path).unwrap(), original_draft);
                }
                assert_eq!(fs::read(files.join("a.not")).unwrap(), b"base");
            }
        }
    });
}

#[test]
fn directory_intent_recovers_paths_without_persisted_document_ids() {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir_all(files.join("old")).unwrap();
        fs::write(files.join("old/a.not"), "base").unwrap();
        let mut core = open(&files, &recovery).await;
        let id = core.open_file("old/a.not").await.unwrap();
        core.replace_text(&id, "base draft").unwrap();
        core.close().await.unwrap();
        drop(core);
        fs::write(
            recovery.join("directory-intent.json"),
            serde_json::to_vec(&json!({
                "operation":"rename", "from":"old", "to":"new", "paths":["old/a.not"]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::rename(files.join("old"), files.join("new")).unwrap();
        let mut core = open(&files, &recovery).await;
        let fresh = core.open_file("new/a.not").await.unwrap();
        assert_ne!(fresh, id);
        assert_eq!(
            core.read(&fresh).unwrap().snapshot.text.as_ref(),
            "base draft"
        );
        assert_eq!(fs::read(files.join("new/a.not")).unwrap(), b"base");
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(recovery.join("directory-intent.json")).unwrap()
            )
            .unwrap(),
            Value::Null
        );
    });
}

#[test]
fn lock_probe_in_another_process() {
    let Some(root) = std::env::var_os("CELESTITE_NATIVE_TEST_LOCK_ROOT") else {
        return;
    };
    let result = FsVault::open_private(Path::new(&root));
    if std::env::var_os("CELESTITE_NATIVE_TEST_EXPECT_BUSY").is_some() {
        assert_eq!(result.err().unwrap().code, ErrorCode::Busy);
    } else {
        assert!(result.is_ok());
    }
}

#[test]
fn exclusive_private_root_is_locked_between_processes_and_released_on_drop() {
    let root = tempfile::tempdir().unwrap();
    let files = FsVault::open_private(root.path()).unwrap();
    let probe = |busy| {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("lock_probe_in_another_process")
            .env("CELESTITE_NATIVE_TEST_LOCK_ROOT", root.path());
        if busy {
            command.env("CELESTITE_NATIVE_TEST_EXPECT_BUSY", "1");
        } else {
            command.env_remove("CELESTITE_NATIVE_TEST_EXPECT_BUSY");
        }
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    };
    probe(true);
    drop(files);
    probe(false);
}
