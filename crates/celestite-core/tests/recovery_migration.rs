#![cfg(all(feature = "native", not(target_arch = "wasm32")))]

use celestite_buffer::{
    Buffer,
    types::{DocumentIdentity, HistoryPacket, Version},
};
use celestite_core::{
    editor::EditorCore,
    fs::native::{FsVault, revision},
    instance::{InstanceIdentity, Vault},
    text::LineEnding,
};
use futures_lite::future::block_on;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

const BASE: &str = "base 😀\n";
const DRAFT: &str = "draft base 😀\n";
const DISK: &str = "\u{feff}base 😀\r\n";

struct LegacyDocument {
    seed: HistoryPacket,
    update: HistoryPacket,
    saved: Version,
    applied: Version,
}

impl LegacyDocument {
    fn new() -> Self {
        Self::with_prefix("draft ")
    }

    fn with_prefix(prefix: &str) -> Self {
        let identity = DocumentIdentity {
            document_id: uuid::Uuid::new_v4().to_string(),
            history_id: uuid::Uuid::new_v4().to_string(),
        };
        let mut buffer = Buffer::new(identity, BASE).unwrap();
        let seed = buffer.export_snapshot().unwrap();
        let saved = buffer.version();
        let change = buffer.edit([(0..0, prefix)]).unwrap();
        Self {
            seed,
            update: change.operation.unwrap(),
            saved,
            applied: buffer.version(),
        }
    }

    fn cursor(&self) -> Value {
        json!({ "bytes": DISK.as_bytes(), "version": self.saved, "observation": 1 })
    }

    fn header(&self) -> Value {
        json!({
            "id": self.seed.identity.document_id,
            "path": "a.not", "seed": self.seed, "sequence": 1,
            "applied": self.applied, "saved_text": BASE,
            "disk_revision": revision(DISK.as_bytes()), "saved_version": self.saved,
            "pending_write": null, "disk_cursor": self.cursor(), "deleted": false,
            "bom": true, "line_ending": "\r\n",
        })
    }
}

#[derive(Default)]
struct LegacyFiles(Vec<(PathBuf, Vec<u8>)>);

impl LegacyFiles {
    fn write(&mut self, root: &Path, path: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        self.0.push((path.clone(), bytes.into()));
        path
    }

    fn json(&mut self, root: &Path, path: &str, value: &Value) -> PathBuf {
        self.write(root, path, &serde_json::to_vec(value).unwrap())
    }

    fn unchanged(&self) {
        for (path, original) in &self.0 {
            assert_eq!(&fs::read(path).unwrap(), original, "{}", path.display());
        }
    }

    fn corrupt(&mut self, paths: &[PathBuf]) {
        let mut damaged = 0;
        for (path, bytes) in &mut self.0 {
            if paths.contains(path) {
                damaged += 1;
                *bytes = b"damaged retired CRDT data".to_vec();
                fs::write(path, bytes).unwrap();
            }
        }
        assert_eq!(damaged, paths.len());
    }
}

fn native_store(root: &Path, document: &LegacyDocument, files: &mut LegacyFiles) -> Vec<PathBuf> {
    let directory = format!(
        "documents/{}",
        blake3::hash(document.seed.identity.document_id.as_bytes()).to_hex()
    );
    let seed = serde_json::to_vec(&document.seed).unwrap();
    let seed_id = blake3::hash(&seed).to_hex().to_string();
    let seed_path = files.write(root, &format!("{directory}/objects/{seed_id}.json"), &seed);
    let baseline = serde_json::to_vec(&json!({
        "saved_text": BASE, "disk_cursor": document.cursor(),
    }))
    .unwrap();
    let baseline_id = blake3::hash(&baseline).to_hex().to_string();
    files.write(
        root,
        &format!("{directory}/objects/{baseline_id}.json"),
        &baseline,
    );
    files.json(
        root,
        &format!("{directory}/head.json"),
        &json!({
            "seed": seed_id, "baseline": baseline_id,
            "id": document.seed.identity.document_id, "path": "a.not", "sequence": 1,
            "applied": document.applied, "disk_revision": revision(DISK.as_bytes()),
            "saved_version": document.saved, "pending_write": null, "deleted": false,
            "bom": true, "line_ending": "\r\n",
        }),
    );
    let journal = files.json(
        root,
        &format!("{directory}/journal/1.json"),
        &json!({
            "packet": document.update, "applied": document.applied,
        }),
    );
    vec![seed_path, journal]
}

fn browser_store(root: &Path, document: &LegacyDocument, files: &mut LegacyFiles) -> Vec<PathBuf> {
    files.json(root, "catalog.json", &json!({
        "schema": 1,
        "entries": [{ "id": document.seed.identity.document_id,
            "historyId": document.seed.identity.history_id, "path": "a.not", "deleted": false }],
    }));
    browser_document(root, document, files, false)
}

fn browser_document(
    root: &Path,
    document: &LegacyDocument,
    files: &mut LegacyFiles,
    deleted: bool,
) -> Vec<PathBuf> {
    let directory = format!("documents/{}", document.seed.identity.document_id);
    let seed = files.write(root, &format!("{directory}/seed.bin"), &document.seed.data);
    let update = files.write(
        root,
        &format!("{directory}/updates/1.bin"),
        &document.update.data,
    );
    let mut header = document.header();
    header["deleted"] = json!(deleted);
    files.json(
        root,
        &format!("{directory}/updates/1.meta.json"),
        &json!({
            "applied": document.applied, "kind": document.update.kind,
        }),
    );
    files.json(
        root,
        &format!("{directory}/head.json"),
        &json!({
            "sequence": 1, "version": document.applied, "header": header,
        }),
    );
    vec![seed, update]
}

fn identity() -> InstanceIdentity {
    InstanceIdentity {
        instance_id: uuid::Uuid::new_v4().to_string(),
        vault: Vault {
            vault_id: "migration-vault".into(),
            history_id: uuid::Uuid::new_v4().to_string(),
        },
    }
}

async fn open(files: &Path, recovery: &Path) -> EditorCore<FsVault> {
    EditorCore::open(
        identity(),
        Some(FsVault::open(files).unwrap()),
        Some(FsVault::open_private(recovery).unwrap()),
    )
    .await
    .unwrap()
}

fn plaintext_only(value: &Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                assert!(
                    ![
                        "seed",
                        "journal",
                        "version",
                        "applied",
                        "history_id",
                        "document_id",
                        "clocks",
                        "packet"
                    ]
                    .contains(&key.as_str()),
                    "CRDT field leaked: {key}"
                );
                plaintext_only(value);
            }
        }
        Value::Array(values) => values.iter().for_each(plaintext_only),
        _ => {}
    }
}

fn exercise_migration(write_store: fn(&Path, &LegacyDocument, &mut LegacyFiles) -> Vec<PathBuf>) {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::create_dir(&recovery).unwrap();
        fs::write(files.join("a.not"), DISK).unwrap();
        let document = LegacyDocument::new();
        let mut legacy = LegacyFiles::default();
        let retired = write_store(&recovery, &document, &mut legacy);
        let mut core = open(&files, &recovery).await;
        let mut resident = core.resident().unwrap();
        assert_eq!(resident.len(), 1);
        let restored = resident.pop().unwrap();
        assert_eq!(restored.status.path, "a.not");
        assert_eq!(restored.snapshot.text.as_ref(), DRAFT);
        assert_eq!(restored.saved_content, BASE);
        assert_eq!(restored.status.file_revision, revision(DISK.as_bytes()));
        assert!(restored.status.dirty);
        assert!(restored.status.recovery_error.is_none());
        assert!(restored.bom);
        assert_eq!(restored.line_ending, LineEnding::CrLf);
        assert!(!restored.undo.can_undo);
        let migrated = restored.status.version.identity().clone();
        assert_ne!(migrated.document_id, document.seed.identity.document_id);
        assert_ne!(migrated.history_id, document.seed.identity.history_id);
        let saved = restored.status.saved_version.as_ref().unwrap();
        assert_eq!(saved.identity(), &migrated);
        assert_eq!(
            core.snapshot_at(&restored.status.id, saved)
                .unwrap()
                .text
                .as_ref(),
            BASE
        );
        core.checkpoint().await.unwrap();

        let drafts: Vec<_> = fs::read_dir(recovery.join("recovery"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(drafts.len(), 1);
        let draft_bytes = fs::read(&drafts[0]).unwrap();
        let draft: Value = serde_json::from_slice(&draft_bytes).unwrap();
        plaintext_only(&draft);
        assert_eq!(draft["schema"], 1);
        assert_eq!(draft["path"], "a.not");
        assert_eq!(draft["text"], DRAFT);
        assert_eq!(draft["baseline"]["bytes"], json!(DISK.as_bytes()));
        assert_eq!(draft["baseline"]["revision"], revision(DISK.as_bytes()));
        assert_eq!(
            fs::read(recovery.join("recovery-format.json")).unwrap(),
            b"1"
        );
        assert_eq!(fs::read(files.join("a.not")).unwrap(), DISK.as_bytes());
        legacy.unchanged();
        drop(core);

        legacy.corrupt(&retired);
        let core = open(&files, &recovery).await;
        let mut resident = core.resident().unwrap();
        assert_eq!(resident.len(), 1);
        let reopened = resident.pop().unwrap();
        assert_eq!(reopened.snapshot.text.as_ref(), DRAFT);
        assert_eq!(reopened.saved_content, BASE);
        assert!(reopened.status.dirty);
        assert!(reopened.status.recovery_error.is_none());
        assert_ne!(reopened.status.version.identity(), &migrated);
        assert_eq!(fs::read(&drafts[0]).unwrap(), draft_bytes);
        assert_eq!(fs::read(files.join("a.not")).unwrap(), DISK.as_bytes());
        legacy.unchanged();
    });
}

#[test]
fn native_crdt_store_is_extracted_once_without_modifying_retired_objects() {
    exercise_migration(native_store);
}

#[test]
fn browser_crdt_store_is_extracted_once_without_modifying_retired_binary_history() {
    exercise_migration(browser_store);
}

fn exercise_recreated_browser_path(partially_migrated: bool) {
    block_on(async {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("files");
        let recovery = root.path().join("private");
        fs::create_dir(&files).unwrap();
        fs::create_dir(&recovery).unwrap();
        fs::write(files.join("a.not"), DISK).unwrap();
        let deleted = LegacyDocument::with_prefix("deleted ");
        let active = LegacyDocument::with_prefix("active ");
        let mut legacy = LegacyFiles::default();
        legacy.json(&recovery, "catalog.json", &json!({
            "schema": 1,
            "entries": [
                { "id": deleted.seed.identity.document_id,
                  "historyId": deleted.seed.identity.history_id, "path": "a.not", "deleted": true },
                { "id": active.seed.identity.document_id,
                  "historyId": active.seed.identity.history_id, "path": "a.not", "deleted": false },
            ],
        }));
        browser_document(&recovery, &deleted, &mut legacy, true);
        browser_document(&recovery, &active, &mut legacy, false);
        let deleted_text = format!("deleted {BASE}");
        let active_text = format!("active {BASE}");
        let partial = recovery.join("recovery/already-extracted.json");
        if partially_migrated {
            fs::create_dir(recovery.join("recovery")).unwrap();
            fs::write(
                &partial,
                serde_json::to_vec(&json!({
                    "schema": 1, "path": "a.not", "text": deleted_text,
                    "baseline": { "bytes": DISK.as_bytes(), "revision": revision(DISK.as_bytes()) },
                    "deleted": true, "pending_write": null,
                }))
                .unwrap(),
            )
            .unwrap();
        }
        assert!(!recovery.join("recovery-format.json").exists());

        for reopen in 0..2 {
            let mut core = open(&files, &recovery).await;
            let documents = core.resident().unwrap();
            assert_eq!(documents.len(), 2, "reopen {reopen}");
            let tombstone = documents
                .iter()
                .find(|document| document.status.deleted)
                .unwrap();
            let live = documents
                .iter()
                .find(|document| !document.status.deleted)
                .unwrap();
            assert_eq!(tombstone.status.path, "a.not");
            assert_eq!(live.status.path, "a.not");
            assert_eq!(tombstone.snapshot.text.as_ref(), deleted_text);
            assert_eq!(live.snapshot.text.as_ref(), active_text);
            assert_ne!(
                tombstone.status.version.identity(),
                live.status.version.identity()
            );
            assert_eq!(core.open_file("a.not").await.unwrap(), live.status.id);
            for document in &documents {
                assert_eq!(document.saved_content, BASE);
                assert!(document.status.recovery_error.is_none());
            }
            core.checkpoint().await.unwrap();
            assert_eq!(fs::read_dir(recovery.join("recovery")).unwrap().count(), 2);
            assert_eq!(fs::read(files.join("a.not")).unwrap(), DISK.as_bytes());
            legacy.unchanged();
            if partially_migrated {
                let preserved: Value =
                    serde_json::from_slice(&fs::read(&partial).unwrap()).unwrap();
                assert_eq!(preserved["text"], deleted_text);
                assert_eq!(preserved["deleted"], true);
            }
        }
    });
}

#[test]
fn browser_migration_preserves_deleted_and_recreated_documents_at_the_same_path() {
    exercise_recreated_browser_path(false);
}

#[test]
fn interrupted_browser_migration_deduplicates_only_the_complete_matching_draft() {
    exercise_recreated_browser_path(true);
}
