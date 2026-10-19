//! Message dispatch around an exclusively borrowed native EditorCore.
use super::{
    buffer::{Command, Contexts, Input, edits, encode_update, validate_base},
    byte_to_utf16,
};
use crate::editor::EditorCore;
use crate::editor::replica::ReplicaDocument;
use crate::editor::types::{EditorMutation, ReplicaHostState};
use crate::error::{EditorError, EditorResult, ErrorCode};
use crate::fs::{FileSystem, WriteMode};
use celestite_buffer::codec::peer_id;
use celestite_buffer::text::utf16_to_byte;
use celestite_buffer::types::{
    Affinity, Anchor, BufferError, EditOptions, HistoryPacket, ImportOptions, Version,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json, to_value};
use std::sync::Arc;

/// The adapter owns encoding context, not text or editor business rules.
/// A runtime may wrap its EditorCore in a queue or lock; each call borrows
/// that same native owner exclusively. Keep one adapter for that owner's
/// lifetime so its caller-context tags can be decoded across undo/redo.
#[derive(Default)]
pub struct EditorAdapter {
    contexts: Contexts,
    pending: Vec<Arc<EditorMutation>>,
    ready: Vec<Value>,
    before: Vec<(Version, Arc<str>)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireReplicaDocument {
    packets: Vec<HistoryPacket>,
    #[serde(default)]
    peer_id: Option<String>,
    state: ReplicaHostState,
}

impl WireReplicaDocument {
    fn native(self) -> EditorResult<ReplicaDocument> {
        let peer_id = self
            .peer_id
            .map(|peer_id| peer_id::parse(&peer_id))
            .transpose()
            .map_err(|error| {
                EditorError::new(ErrorCode::InvalidEdit, error.to_string(), &self.state.path)
            })?;
        Ok(ReplicaDocument {
            packets: self.packets,
            peer_id,
            state: self.state,
        })
    }
}

fn decode<T: DeserializeOwned>(value: Value, path: &str) -> EditorResult<T> {
    serde_json::from_value(value)
        .map_err(|error| EditorError::new(ErrorCode::InvalidEdit, error.to_string(), path))
}

/// Canonical IDs are strings at the wire boundary; legacy spelling is input-only.
fn decode_peer_id(params: &Value, path: &str) -> EditorResult<Option<u64>> {
    let Some(value) = params.get("peerId") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value.as_str().ok_or_else(|| {
        EditorError::new(ErrorCode::InvalidEdit, "Expected a decimal peer ID", path)
    })?;
    peer_id::parse(value)
        .map(Some)
        .map_err(|error| EditorError::new(ErrorCode::InvalidEdit, error, path))
}

impl EditorAdapter {
    pub async fn call<F: FileSystem, R: FileSystem>(
        &mut self,
        core: &mut EditorCore<F, R>,
        method: &str,
        params: Value,
    ) -> EditorResult<Value> {
        let id = params["id"].as_str().unwrap_or("");
        let value = match method {
            "apply" => {
                self.apply(core, id, decode(params["command"].clone(), id)?)?;
                to_value(id)
            }
            "anchors_at" => {
                let version: Version = decode(params["version"].clone(), id)?;
                let document = core.read(id)?;
                validate_base(&document.status.version, &version)?;
                let snapshot = document.snapshot;
                let positions: Vec<(usize, Affinity)> = decode(params["positions"].clone(), id)?;
                let positions = positions
                    .into_iter()
                    .map(|(offset, affinity)| {
                        Ok((utf16_to_byte(&snapshot.text, offset)?, affinity))
                    })
                    .collect::<Result<Vec<_>, BufferError>>()?;
                to_value(core.anchors_at(id, &positions)?)
            }
            "resolve_anchors" => {
                let checkpoint: Version = decode(params["checkpoint"].clone(), id)?;
                let document = core.read(id)?;
                if !document.status.version.contains(&checkpoint) {
                    return Err(BufferError::StaleVersion.into());
                }
                let anchors: Vec<Anchor> = decode(params["anchors"].clone(), id)?;
                let offsets = core
                    .resolve_anchors(id, &anchors)?
                    .into_iter()
                    .map(|offset| byte_to_utf16(&document.snapshot.text, offset))
                    .collect::<Result<Vec<_>, _>>()?;
                to_value((document.status.version, offsets))
            }
            "join" => {
                let path = params["path"].as_str().ok_or_else(|| {
                    EditorError::new(ErrorCode::InvalidPath, "Missing file path", "")
                })?;
                let packet = decode(params["packet"].clone(), path)?;
                let peer_id = decode_peer_id(&params, path)?;
                let id = core.join_with_peer_id(path, packet, peer_id)?;
                to_value(core.read(&id)?)
            }
            "replica_session" => {
                // A successful replacement drops the old histories. Encode any
                // earlier accepted receipts while their BEFORE states exist.
                self.capture(core)?;
                let documents: Vec<WireReplicaDocument> = decode(params["documents"].clone(), "")?;
                let documents = documents
                    .into_iter()
                    .map(WireReplicaDocument::native)
                    .collect::<EditorResult<Vec<_>>>()?;
                core.replace_replica_session(documents)?;
                to_value(core.resident()?)
            }
            "replica_release" => {
                core.release_replica_document(id)?;
                to_value(())
            }
            "replica_join" => {
                let document: WireReplicaDocument = decode(params["document"].clone(), id)?;
                let id = core.join_replica_document(document.native()?)?;
                to_value(core.read(&id)?)
            }
            "replica_host_state" => {
                core.apply_host_state(id, decode(params["state"].clone(), id)?)?;
                to_value(core.read(id)?)
            }
            "export_snapshot" => to_value(core.snapshot(id)?),
            "export_updates" => {
                to_value(core.updates(id, &decode(params["version"].clone(), id)?)?)
            }
            "open" => {
                let path = params["path"].as_str().ok_or_else(|| {
                    EditorError::new(ErrorCode::InvalidPath, "Missing file path", "")
                })?;
                let id = core.open_file(path).await?;
                to_value(core.read(&id)?)
            }
            "read" => to_value(core.read(id)?),
            "resident" => to_value(core.resident()?),
            "document_source" => {
                let ids: Vec<String> = decode(params["ids"].clone(), "")?;
                to_value(core.document_source(&ids))
            }
            "observe_files" => {
                let ids: Vec<String> = decode(params["ids"].clone(), "")?;
                to_value(core.observe_files(&ids).await?)
            }
            "save" => {
                if let Err(error) = core.save(id, None).await
                    && error.code == ErrorCode::Unsupported
                {
                    return Err(error);
                }
                to_value(core.read(id)?)
            }
            "retry_observation" => {
                core.retry_file_observation(id).await?;
                to_value(core.read(id)?)
            }
            "resolve" => {
                core.resolve(id, params["action"].as_str().unwrap_or(""))
                    .await?;
                to_value(core.read(id)?)
            }
            "flush" => {
                core.flush().await?;
                Ok(Value::Null)
            }
            "checkpoint" => {
                core.checkpoint().await?;
                Ok(Value::Null)
            }
            "close" => {
                core.close().await?;
                Ok(Value::Null)
            }
            "file" => return self.file(core, &params).await,
            _ => {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Unknown editor service operation",
                    "",
                ));
            }
        };
        value.map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), ""))
    }

    fn apply<F: FileSystem, R: FileSystem>(
        &mut self,
        core: &mut EditorCore<F, R>,
        id: &str,
        command: Command,
    ) -> EditorResult<()> {
        let redo = matches!(&command, Command::Redo { .. });
        let document = core.read(id)?;
        let before_version = document.status.version;
        let before = document.snapshot;
        let mut reserved = Vec::new();
        for document in core.resident_status()? {
            reserved.extend(core.undo_tags(&document.id)?);
        }
        self.contexts.reserve(reserved);
        let mut allocated = None;
        let result = match command {
            Command::Edit {
                base,
                input,
                group,
                undo,
            } => {
                validate_base(&before_version, &base)?;
                let input = match input {
                    Input::Edits { edits: script } => Ok(edits(&before.text, script)?),
                    Input::Text { text } => Err(text),
                };
                let (undo, tag) = self.contexts.context(&before.text, undo)?;
                allocated = tag;
                let options = EditOptions { group, undo };
                match input {
                    Ok(script) => core.edit_with(id, script, options),
                    Err(text) => core.replace_text_with(id, &text, options),
                }
            }
            Command::Undo { base, context } | Command::Redo { base, context } => {
                validate_base(&before_version, &base)?;
                let (context, tag) = self.contexts.context(&before.text, context)?;
                allocated = tag;
                if redo {
                    core.redo_with(id, context)
                } else {
                    core.undo_with(id, context)
                }
            }
            Command::Import { packet, reset_undo } => {
                core.import_with(id, packet, ImportOptions { reset_undo })
            }
            Command::ClearUndo => core.clear_undo(id),
        };
        if !result.as_ref().is_ok_and(|receipt| receipt.update.changed) {
            self.contexts.discard(allocated);
        } else {
            // The wire input already needed this immutable snapshot. Reuse it
            // for output conversion rather than forking history after editing.
            self.before.push((before_version, before.text));
        }
        result.map(|_| ())
    }

    /// Encode before releasing native receipts. If encoding fails, retain the
    /// entire batch for retry, including its restoration metadata lifetimes.
    fn capture<F: FileSystem, R: FileSystem>(
        &mut self,
        core: &mut EditorCore<F, R>,
    ) -> EditorResult<()> {
        self.pending.extend(core.take_mutations());
        let mut encoded = Vec::with_capacity(self.pending.len());
        for mutation in &self.pending {
            let before = if mutation.update.before == mutation.update.after {
                mutation.document.snapshot.text.clone()
            } else if let Some((_, text)) = self
                .before
                .iter()
                .find(|(version, _)| *version == mutation.update.before)
            {
                text.clone()
            } else if let Some(previous) = self
                .pending
                .iter()
                .find(|previous| previous.document.status.version == mutation.update.before)
            {
                previous.document.snapshot.text.clone()
            } else {
                core.snapshot_at(&mutation.document.status.id, &mutation.update.before)?
                    .text
            };
            let update = encode_update(
                &self.contexts,
                &mutation.update,
                &before,
                &mutation.document.snapshot.text,
                mutation.document.snapshot.state_revision,
                &mutation.document.undo,
                mutation.pending,
            )?;
            encoded.push(json!({
                "document": mutation.document,
                "update": update,
            }));
        }
        self.ready.extend(encoded);
        self.pending.clear();
        self.before.clear();
        Ok(())
    }

    pub fn take_mutations<F: FileSystem, R: FileSystem>(
        &mut self,
        core: &mut EditorCore<F, R>,
    ) -> EditorResult<Vec<Value>> {
        self.capture(core)?;
        let mut live = Vec::new();
        for document in core.resident_status()? {
            live.extend(core.undo_tags(&document.id)?);
        }
        self.contexts.prune(live);
        Ok(std::mem::take(&mut self.ready))
    }

    async fn file<F: FileSystem, R: FileSystem>(
        &mut self,
        core: &mut EditorCore<F, R>,
        params: &Value,
    ) -> EditorResult<Value> {
        let path = params
            .get("path")
            .or_else(|| params.get("from"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let value = match params["method"].as_str().unwrap_or("") {
            "stat" => to_value(core.file_stat(path).await?),
            "readDir" => to_value(core.file_read_dir(path).await?),
            "readFile" => to_value(core.file_read(path).await?),
            "readFileSnapshot" => to_value(core.file_read_snapshot(path).await?),
            "mkdir" => {
                core.file_mkdir(
                    path,
                    params["options"]["recursive"].as_bool().unwrap_or(false),
                )
                .await?;
                Ok(Value::Null)
            }
            "writeFile" => {
                let data: Vec<u8> = decode(params["data"].clone(), path)?;
                to_value(
                    core.file_write(
                        path,
                        &data,
                        decode::<WriteMode>(params["options"]["mode"].clone(), path)?,
                        params["options"]["expectedRevision"].as_str(),
                    )
                    .await?,
                )
            }
            "rename" => {
                let to = params["to"].as_str().ok_or_else(|| {
                    EditorError::new(ErrorCode::InvalidPath, "Missing destination", path)
                })?;
                core.file_rename(path, to).await?;
                Ok(Value::Null)
            }
            "remove" => {
                core.file_remove(
                    path,
                    params["options"]["recursive"].as_bool().unwrap_or(false),
                )
                .await?;
                Ok(Value::Null)
            }
            _ => {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Unknown file operation",
                    path,
                ));
            }
        };
        value.map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), path))
    }
}

#[cfg(test)]
mod peer_id_tests {
    use super::{ErrorCode, decode_peer_id};
    use serde_json::json;

    #[test]
    fn peer_ids_use_canonical_decimal_strings() {
        assert_eq!(
            decode_peer_id(&json!({"peerId":"9007199254740993"}), "doc").unwrap(),
            Some(9_007_199_254_740_993)
        );
        assert_eq!(decode_peer_id(&json!({}), "doc").unwrap(), None);
        assert_eq!(
            decode_peer_id(&json!({"peerId":null}), "doc").unwrap(),
            None
        );
        // The retired v3 spelling is ignored, never reinterpreted as a peer ID.
        assert_eq!(
            decode_peer_id(&json!({"writerId":"1"}), "doc").unwrap(),
            None
        );
    }

    #[test]
    fn ambiguous_or_invalid_identity_is_not_silently_reallocated() {
        for params in [
            json!({"peerId":1}),
            json!({"peerId":"01"}),
            json!({"peerId":"18446744073709551616"}),
        ] {
            assert_eq!(
                decode_peer_id(&params, "doc").unwrap_err().code,
                ErrorCode::InvalidEdit
            );
        }
    }
}
