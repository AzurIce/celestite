//! Plaintext drafts and file-operation recovery. No CRDT data is written here.
use super::replica::ReplicaState;
use super::state::{DirectoryIntent, DiskCursor, DocumentState, PendingWrite, WritePhase};
use super::{EditorCore, Record, decode, encode, validate_path, validate_text};
use crate::error::{EditorError, EditorResult, ErrorCode};
use crate::fs::{EntryKind, FileSystem, WriteMode};
use celestite_buffer::{Buffer, types::DocumentIdentity};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

mod legacy;

const FORMAT: &str = "recovery-format.json";
const INTENT: &str = "directory-intent.json";
const MAX_RECOVERY_BYTES: u64 = 64 * 1024 * 1024;

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Baseline {
    pub bytes: Vec<u8>,
    pub revision: String,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WriteRecovery {
    pub text: String,
    pub phase: WritePhase,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Draft {
    pub schema: u32,
    pub path: String,
    pub text: String,
    pub baseline: Baseline,
    pub deleted: bool,
    pub pending_write: Option<WriteRecovery>,
}

async fn read_json<S: FileSystem, T: DeserializeOwned>(
    fs: &S,
    path: &str,
) -> EditorResult<Option<T>> {
    let bytes = match fs.read_file(path, Some(MAX_RECOVERY_BYTES)).await {
        Ok(value) => value.data,
        Err(error) if error.code == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    // OPFS creates a new directory entry before createWritable publishes bytes.
    // An interrupted first write can leave this empty stub; valid recovery JSON
    // is never empty, and replacing an existing file preserves its old bytes.
    if bytes.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        EditorError::new(
            ErrorCode::Io,
            format!("Invalid recovery data: {error}"),
            path,
        )
    })
}

async fn write_json<S: FileSystem, T: Serialize + ?Sized>(
    fs: &S,
    path: &str,
    value: &T,
) -> EditorResult<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), path))?;
    fs.write_file(path, &bytes, WriteMode::Upsert, None).await?;
    Ok(())
}

impl<F: FileSystem, R: FileSystem> EditorCore<F, R> {
    pub(super) async fn restore(&mut self) -> EditorResult<()> {
        let Some(fs) = &self.recovery else {
            return Ok(());
        };
        fs.mkdir("recovery", true).await?;
        let format: Option<u32> = read_json(fs, FORMAT).await?;
        if format.is_some_and(|schema| schema != 1) {
            return Err(EditorError::new(
                ErrorCode::Io,
                "Unsupported recovery format",
                FORMAT,
            ));
        }
        let mut drafts = Vec::new();
        for entry in fs.read_dir("recovery").await? {
            if entry.kind != EntryKind::File || !entry.path.ends_with(".json") {
                continue;
            }
            if let Some(draft) = read_json::<_, Draft>(fs, &entry.path).await? {
                drafts.push((entry.path, draft));
            }
        }
        if format.is_none() {
            // Old CRDT files are read once to rescue text, and are never modified.
            for draft in legacy::drafts(fs).await? {
                if !drafts.iter().any(|(_, existing)| existing == &draft) {
                    drafts.push((format!("recovery/{}.json", Self::new_id()), draft));
                }
            }
        }
        let mut paths = std::collections::BTreeSet::new();
        for (file, draft) in drafts {
            validate_path(&draft.path)?;
            validate_text(&draft.text, &draft.path)?;
            if draft.schema != 1
                || draft.path.is_empty()
                || (!draft.deleted && !paths.insert(draft.path.clone()))
            {
                return Err(EditorError::new(
                    ErrorCode::Io,
                    "Invalid or duplicate draft",
                    &draft.path,
                ));
            }
            let decoded = decode(&draft.baseline.bytes, &draft.path)?;
            let identity = DocumentIdentity {
                document_id: Self::new_id(),
                history_id: Self::new_id(),
            };
            let mut buffer = Buffer::new(identity.clone(), &decoded.text)?;
            let baseline_version = buffer.version();
            let pending_write = if let Some(pending) = draft.pending_write {
                validate_text(&pending.text, &draft.path)?;
                let _ = buffer.replace_text(&pending.text)?;
                Some(PendingWrite {
                    text: pending.text,
                    version: buffer.version(),
                    phase: pending.phase,
                })
            } else {
                None
            };
            let _ = buffer.replace_text(&draft.text)?;
            let _ = buffer.clear_undo()?;
            let header = DocumentState {
                id: identity.document_id.clone(),
                path: draft.path,
                saved_text: decoded.text,
                disk_revision: draft.baseline.revision,
                saved_version: Some(baseline_version.clone()),
                pending_write,
                disk_cursor: Some(DiskCursor {
                    version: baseline_version,
                    observation: 0,
                    bytes: draft.baseline.bytes,
                }),
                deleted: draft.deleted,
                bom: decoded.bom,
                line_ending: decoded.line_ending,
            };
            let mut record = Record::new(header, buffer, ReplicaState::default());
            record.recovery_file = file;
            self.records.insert(identity.document_id, record);
        }
        self.directory_intent = if format.is_some() {
            read_json(fs, INTENT).await?.flatten()
        } else {
            legacy::directory_intent(fs).await?
        };
        if format.is_none() {
            self.checkpoint().await?;
            write_json(self.recovery.as_ref().unwrap(), FORMAT, &1_u32).await?;
        }
        Ok(())
    }

    pub(super) async fn checkpoint_document(&mut self, id: &str) -> EditorResult<()> {
        let Some(fs) = &self.recovery else {
            return Ok(());
        };
        let record = self.record(id)?;
        let path = record.recovery_file.clone();
        let result = if record.dirty || record.header.pending_write.is_some() || record.conflict {
            let bytes = record
                .header
                .disk_cursor
                .as_ref()
                .map(|cursor| cursor.bytes.clone())
                .unwrap_or_else(|| encode(&record.header, &record.header.saved_text));
            let draft =
                Draft {
                    schema: 1,
                    path: record.header.path.clone(),
                    text: record.buffer.snapshot().text.to_string(),
                    baseline: Baseline {
                        bytes,
                        revision: record.header.disk_revision.clone(),
                    },
                    deleted: record.header.deleted,
                    pending_write: record.header.pending_write.as_ref().map(|pending| {
                        WriteRecovery {
                            text: pending.text.clone(),
                            phase: pending.phase,
                        }
                    }),
                };
            write_json(fs, &path, &draft).await
        } else {
            match fs.remove(&path, false).await {
                Err(error) if error.code == ErrorCode::NotFound => Ok(()),
                other => other,
            }
        };
        self.records.get_mut(id).unwrap().recovery_pending_since = None;
        match &result {
            Err(error) => self.recovery_error = Some(error.clone()),
            Ok(())
                if self
                    .recovery_error
                    .as_ref()
                    .is_some_and(|error| error.path == path) =>
            {
                self.recovery_error = None
            }
            _ => {}
        }
        result
    }

    /// Flush recoverable text and pending file operations, without saving ordinary files.
    pub async fn checkpoint(&mut self) -> EditorResult<()> {
        let documents = self.checkpoint_documents().await;
        let intent = self.directory_intent.clone();
        // The directory intent may be the only remaining evidence of a move or
        // remove. Attempt it even when an unrelated document failed to write.
        let intent = self.set_directory_intent(intent.as_ref()).await;
        let result = documents.and(intent);
        self.recovery_error = result.as_ref().err().cloned();
        result
    }

    pub(super) async fn checkpoint_documents(&mut self) -> EditorResult<()> {
        let ids: Vec<_> = self.records.keys().cloned().collect();
        let mut failure = None;
        for id in ids {
            if let Err(error) = self.checkpoint_document(&id).await {
                failure.get_or_insert(error);
            }
        }
        // Every attempted document now has its automatic deadline cleared.
        // Retain the first failure until a later explicit checkpoint succeeds.
        if let Some(error) = failure {
            self.recovery_error = Some(error.clone());
            Err(error)
        } else {
            Ok(())
        }
    }

    pub(super) async fn set_directory_intent(
        &mut self,
        intent: Option<&DirectoryIntent>,
    ) -> EditorResult<()> {
        if let Some(fs) = &self.recovery
            && let Err(error) = write_json(fs, INTENT, &intent).await
        {
            self.recovery_error = Some(error.clone());
            return Err(error);
        }
        self.directory_intent = intent.cloned();
        Ok(())
    }
}
