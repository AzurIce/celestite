//! Serialization adapter for Worker, IPC and headless core callers.
use super::*;

impl<B: Backend> EditorCore<B> {
    /// Same service commands over Worker, IPC, or a headless reference caller.
    pub async fn execute_service(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> EditorResult<serde_json::Value> {
        use serde_json::{Value, to_value};
        let id = params["id"].as_str().unwrap_or("");
        let value = match method {
            "anchors_at" => {
                let version = serde_json::from_value(params["version"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                let positions: Vec<(usize, Affinity)> =
                    serde_json::from_value(params["positions"].clone())
                        .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                to_value(self.anchors_at(id, &version, &positions)?)
            }
            "resolve_anchors" => {
                let checkpoint = serde_json::from_value(params["checkpoint"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                let anchors: Vec<Anchor> = serde_json::from_value(params["anchors"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                to_value(self.resolve_anchors(id, &checkpoint, &anchors)?)
            }
            "preview_subscribe" => {
                let client = params["clientSession"].as_str().unwrap_or("");
                to_value(self.subscribe_preview(id, client)?)
            }
            "preview_unsubscribe" => to_value(self.unsubscribe_preview(
                params["subscriptionId"].as_str().unwrap_or(""),
                params["clientSession"].as_str().unwrap_or(""),
            )),
            "preview_state" => to_value(self.preview_state(id)?),
            "preview_release_client" => {
                self.release_preview_client(params["clientSession"].as_str().unwrap_or(""));
                Ok(Value::Null)
            }
            "preview_take_task" => to_value(self.take_preview_task(id)?),
            "preview_complete" => {
                let completion = serde_json::from_value(params["completion"].clone())
                    .map_err(|e| EditorError::new("InvalidPreview", e.to_string(), id))?;
                to_value(self.complete_preview(completion))
            }
            "preview_retry" => to_value(self.retry_preview(id)?),
            "preview_link" => to_value(self.preview_link(
                id,
                params["taskId"].as_str().unwrap_or(""),
                params["target"].as_str().unwrap_or(""),
            )?),
            "preview_events" => to_value(self.take_preview_events()),
            "preview_invalidate_project" => {
                self.invalidate_preview_project();
                to_value(())
            }
            "join" => {
                let path = params["path"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidPath", "Missing file path", ""))?;
                let packet = serde_json::from_value(params["packet"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), path))?;
                let writer = params["writerId"]
                    .as_str()
                    .map(str::parse::<u64>)
                    .transpose()
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), path))?;
                let id = self.join_with_writer(path, packet, writer).await?;
                to_value(self.read(&id)?)
            }
            "replica_session" => {
                let documents = serde_json::from_value(params["documents"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                self.replace_replica_session(documents).await?;
                to_value(self.resident()?)
            }
            "replica_release" => {
                self.release_replica_document(id)?;
                to_value(())
            }
            "replica_join" => {
                let document = serde_json::from_value(params["document"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                let id = self.join_replica_document(document).await?;
                to_value(self.read(&id)?)
            }
            "replica_host_state" => {
                let state = serde_json::from_value(params["state"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                self.apply_host_state(id, state).await?;
                to_value(self.read(id)?)
            }
            "export_snapshot" => to_value(self.snapshot(id)?),
            "export_updates" => {
                let version = serde_json::from_value(params["version"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                to_value(self.updates(id, &version)?)
            }
            "apply" => {
                let command = serde_json::from_value(params["command"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                self.apply(id, command).await?;
                // The mutation itself is delivered exactly once in the runtime's
                // mutation batch. The reply only identifies the target document.
                to_value(id)
            }
            "open" => {
                let path = params["path"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidPath", "Missing file path", ""))?;
                let id = self.open_file(path).await?;
                to_value(self.read(&id)?)
            }
            "read" => to_value(self.read(id)?),
            "resident" => to_value(self.resident()?),
            "observe_files" => {
                let ids: Vec<String> = serde_json::from_value(params["ids"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                let mut documents = vec![];
                for id in ids {
                    if let Err(error) = self.refresh(&id).await {
                        if let Some(record) = self.records.get_mut(&id) {
                            record.error = Some(error.message);
                        }
                    }
                    documents.push(self.read(&id)?);
                }
                to_value(documents)
            }
            "save" => {
                let _ = self.save(id, None).await;
                to_value(self.read(id)?)
            }
            "retry_observation" => {
                self.retry_file_observation(id).await?;
                to_value(self.read(id)?)
            }
            "retry_history" => {
                self.retry_history().await?;
                to_value(self.read(id)?)
            }
            "resolve" => {
                self.resolve(id, params["action"].as_str().unwrap_or(""))
                    .await?;
                to_value(self.read(id)?)
            }
            "flush" => {
                self.flush().await?;
                Ok(Value::Null)
            }
            "flush_history" | "close" => {
                self.retry_history().await?;
                if method == "close" {
                    self.previews.clear();
                }
                Ok(Value::Null)
            }
            "file" => {
                let method = params["method"].as_str().unwrap_or("").to_string();
                return self.file_operation(&method, params).await;
            }
            _ => {
                return Err(EditorError::new(
                    "Unsupported",
                    "Unknown editor service operation",
                    "",
                ));
            }
        };
        value.map_err(|e| EditorError::new("IO", e.to_string(), ""))
    }
}
