//! Thin WASM bindings for the shared kernel.
//! JSON keeps 64-bit peer IDs as strings.
use crate::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

fn encode(value: impl Serialize) -> String {
    serde_json::to_string(&value).unwrap()
}
fn decode<T: for<'a> Deserialize<'a>>(json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(|e| {
        JsValue::from_str(&encode(
            serde_json::json!({"code":"invalid_request", "message":e.to_string()}),
        ))
    })
}
fn error(e: CoreError) -> JsValue {
    JsValue::from_str(&encode(&e))
}

fn peer(value: Option<String>) -> Result<Option<u64>, JsValue> {
    value
        .map(|value| {
            value
                .parse()
                .map_err(|_| JsValue::from_str("invalid decimal writer id"))
        })
        .transpose()
}

/// Pure preview computation for the dedicated analysis Worker. Creating an
/// EditorBinding, opening OPFS, or joining a CRDT history is unnecessary.
#[cfg(feature = "preview")]
#[wasm_bindgen]
pub fn render_preview(task: &str) -> Result<String, JsValue> {
    let task: PreviewTask = decode(task)?;
    Ok(encode(compute_preview(&task)))
}

#[cfg(feature = "preview")]
#[wasm_bindgen]
pub fn preview_resource_requests(task: &str) -> Result<String, JsValue> {
    let task: PreviewTask = decode(task)?;
    Ok(encode(crate::preview::preview_resource_requests(&task)))
}

/// Worker-owned shared editor with its browser IO Backend.
#[wasm_bindgen]
pub struct EditorBinding {
    core: EditorCore<crate::browser::BrowserBackend>,
}
#[wasm_bindgen]
impl EditorBinding {
    pub async fn open(
        identity: String,
        io: js_sys::Function,
        merge_external: bool,
    ) -> Result<EditorBinding, JsValue> {
        let backend = crate::browser::BrowserBackend::new(io, decode(&identity)?);
        Ok(Self {
            core: EditorCore::open_with_options(
                backend,
                EditorOptions {
                    external_changes: if merge_external {
                        ExternalChangePolicy::Merge
                    } else {
                        ExternalChangePolicy::Conflict
                    },
                    defer_filesystem_diff: false,
                },
            )
            .await
            .map_err(|e| JsValue::from_str(&encode(e)))?,
        })
    }
    pub async fn call(&mut self, method: String, params: String) -> Result<String, JsValue> {
        call_editor(&mut self.core, method, params).await
    }
}

/// A real EditorCore with volatile private history for independent debug replicas.
#[wasm_bindgen]
pub struct MemoryEditorBinding {
    core: EditorCore<MemoryBackend>,
}
#[wasm_bindgen]
impl MemoryEditorBinding {
    pub async fn open(identity: String) -> Result<MemoryEditorBinding, JsValue> {
        let backend = MemoryBackend::new(decode(&identity)?, || js_sys::Date::now() as u64);
        Ok(Self {
            core: EditorCore::open(backend)
                .await
                .map_err(|e| JsValue::from_str(&encode(e)))?,
        })
    }
    pub async fn call(&mut self, method: String, params: String) -> Result<String, JsValue> {
        call_editor(&mut self.core, method, params).await
    }
}

/// A direct Buffer binding: one command produces one result, with no separate
/// notification drain, host, lock wrapper or mutable IO dependency.
#[wasm_bindgen]
pub struct BufferBinding {
    buffer: Buffer,
}

#[wasm_bindgen]
impl BufferBinding {
    #[wasm_bindgen(constructor)]
    pub fn new(
        identity: &str,
        writer: Option<String>,
        initial: &str,
    ) -> Result<BufferBinding, JsValue> {
        Ok(Self {
            buffer: Buffer::new(decode(identity)?, peer(writer)?, initial).map_err(error)?,
        })
    }
    pub fn from_snapshot(packet: &str, writer: Option<String>) -> Result<BufferBinding, JsValue> {
        Ok(Self {
            buffer: Buffer::from_snapshot(&decode(packet)?, peer(writer)?).map_err(error)?,
        })
    }
    pub fn apply(&mut self, command: &str) -> Result<String, JsValue> {
        Ok(encode(self.buffer.apply(decode(command)?).map_err(error)?))
    }
    pub fn snapshot(&self) -> String {
        encode(self.buffer.snapshot())
    }
    pub fn writer_id(&self) -> String {
        self.buffer.writer_id()
    }
    pub fn undo_state(&self) -> String {
        encode(self.buffer.undo_state())
    }
    pub fn encoded_version(&self) -> Result<Vec<u8>, JsValue> {
        self.buffer.version().encode().map_err(error)
    }
    pub fn decode_version(&self, bytes: &[u8]) -> Result<String, JsValue> {
        Ok(encode(
            Version::decode(self.buffer.identity().clone(), bytes).map_err(error)?,
        ))
    }
    pub fn export_snapshot(&self) -> Result<String, JsValue> {
        Ok(encode(self.buffer.export_snapshot().map_err(error)?))
    }
    pub fn export_updates_since(&self, version: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.buffer
                .export_updates_since(&decode(version)?)
                .map_err(error)?,
        ))
    }
    pub fn anchor_at(&self, offset: f64, affinity: &str) -> Result<String, JsValue> {
        if !offset.is_finite()
            || offset.fract() != 0.0
            || offset < 0.0
            || offset > usize::MAX as f64
        {
            return Err(JsValue::from_str(&encode(
                serde_json::json!({"code":"invalid_request","message":"anchor offset must be a non-negative integer within the platform index range"}),
            )));
        }
        Ok(encode(
            self.buffer
                .anchor_at(offset as usize, decode(affinity)?)
                .map_err(error)?,
        ))
    }
    pub fn resolve_anchor(&self, anchor: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.buffer
                .resolve_anchor(&decode(anchor)?)
                .map_err(error)?,
        ))
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum CallOutcome {
    Ok { value: serde_json::Value },
    Error { error: EditorError },
}
#[derive(Serialize)]
struct CallReply {
    #[serde(flatten)]
    outcome: CallOutcome,
    mutations: Vec<Arc<EditorMutation>>,
}

async fn call_editor<B: Backend>(
    core: &mut EditorCore<B>,
    method: String,
    params: String,
) -> Result<String, JsValue> {
    let outcome = match core.execute_service(&method, decode(&params)?).await {
        Ok(value) => CallOutcome::Ok { value },
        Err(error) => CallOutcome::Error { error },
    };
    // Even a failing save/refresh may have accepted an external text update.
    // Return those effects before the JS adapter handles the command's error.
    Ok(encode(CallReply {
        outcome,
        mutations: core.take_mutations(),
    }))
}
