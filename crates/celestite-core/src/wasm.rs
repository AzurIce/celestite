//! Thin WASM bindings for the shared kernel.
//! JSON keeps 64-bit peer IDs as strings.
use crate::backend::memory::MemoryBackend;
use crate::backend::{Backend, EditorError};
use crate::editor::{EditorCore, EditorOptions, ExternalChangePolicy};
use crate::preview::sessions::PreviewController;
use crate::preview::{
    PreviewCompletion, PreviewEvent, PreviewLink, PreviewState, PreviewSubscription, PreviewTask,
};
#[cfg(feature = "preview")]
use crate::preview::{PreviewResourceRequest, compute_preview};
use crate::protocol::buffer::BufferAdapter;
use crate::protocol::byte_to_utf16;
use crate::protocol::editor::EditorAdapter;
use crate::source::DocumentSourceSnapshot;
use celestite_buffer::Buffer;
use celestite_buffer::codec::peer_id;
use celestite_buffer::text::utf16_to_byte;
use celestite_buffer::types::{Affinity, Anchor, BufferError, Version};
use serde::{Deserialize, Serialize};
use tsify::{Ts, Tsify};
use wasm_bindgen::{JsValue, prelude::wasm_bindgen};

fn encode(value: impl Serialize) -> String {
    serde_json::to_string(&value).unwrap()
}
fn invalid_request(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&encode(
        serde_json::json!({"code":"invalid_request", "message":error.to_string()}),
    ))
}
fn decode<T: for<'a> Deserialize<'a>>(json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(invalid_request)
}
fn error(e: BufferError) -> JsValue {
    JsValue::from_str(&encode(&e))
}
fn editor_error(error: EditorError) -> JsValue {
    // Typed preview calls reject with data, so the owner can distinguish a
    // stale capture from an executor failure without parsing an error message.
    js_sys::JSON::parse(&encode(error)).expect("EditorError is valid JSON")
}

fn decode_peer_id(value: Option<String>) -> Result<Option<u64>, JsValue> {
    value
        .map(|value| {
            peer_id::parse(&value).map_err(|_| JsValue::from_str("invalid decimal peer id"))
        })
        .transpose()
}

/// Pure preview computation for the dedicated analysis Worker. Creating an
/// EditorBinding, opening OPFS, or joining a CRDT history is unnecessary.
#[cfg(feature = "preview")]
#[wasm_bindgen]
pub fn render_preview(task: Ts<PreviewTask>) -> Result<Ts<PreviewCompletion>, JsValue> {
    let task = task.to_rust().map_err(invalid_request)?;
    compute_preview(&task).into_ts().map_err(invalid_request)
}

#[cfg(feature = "preview")]
#[wasm_bindgen]
pub fn preview_resource_requests(
    task: Ts<PreviewTask>,
) -> Result<Vec<Ts<PreviewResourceRequest>>, JsValue> {
    let task = task.to_rust().map_err(invalid_request)?;
    crate::preview::project::preview_resource_requests(&task)
        .into_iter()
        .map(|request| request.into_ts().map_err(invalid_request))
        .collect()
}

/// Independent derived consumer. Reads snapshots, never owns or calls an Editor.
#[wasm_bindgen]
pub struct PreviewBinding {
    preview: PreviewController,
}

#[wasm_bindgen]
impl PreviewBinding {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PreviewBinding {
        Self {
            preview: PreviewController::default(),
        }
    }
    pub fn synchronize(&mut self, source: Ts<DocumentSourceSnapshot>) -> Result<bool, JsValue> {
        let source = source.to_rust().map_err(invalid_request)?;
        Ok(self
            .preview
            .synchronize(&source, js_sys::Date::now() as u64))
    }
    pub fn subscribe(
        &mut self,
        id: &str,
        client_session: &str,
    ) -> Result<Ts<PreviewSubscription>, JsValue> {
        self.preview
            .subscribe(id, client_session, js_sys::Date::now() as u64)
            .map_err(editor_error)?
            .into_ts()
            .map_err(invalid_request)
    }
    pub fn unsubscribe(&mut self, subscription_id: &str, client_session: &str) -> bool {
        self.preview.unsubscribe(subscription_id, client_session)
    }
    pub fn release_client(&mut self, client_session: &str) {
        self.preview.release_client(client_session);
    }
    pub fn state(&self, id: &str) -> Result<Ts<PreviewState>, JsValue> {
        self.preview
            .state(id)
            .map_err(editor_error)?
            .into_ts()
            .map_err(invalid_request)
    }
    pub fn required_snapshots(&self, id: &str) -> Result<Vec<String>, JsValue> {
        self.preview.required_snapshots(id).map_err(editor_error)
    }
    pub fn take_task(
        &mut self,
        id: &str,
        source: Ts<DocumentSourceSnapshot>,
    ) -> Result<Option<Ts<PreviewTask>>, JsValue> {
        let source = source.to_rust().map_err(invalid_request)?;
        self.preview
            .take_task(id, &source, js_sys::Date::now() as u64)
            .map_err(editor_error)?
            .map(|task| task.into_ts().map_err(invalid_request))
            .transpose()
    }
    pub fn complete(&mut self, completion: Ts<PreviewCompletion>) -> Result<bool, JsValue> {
        let completion = completion.to_rust().map_err(invalid_request)?;
        Ok(self.preview.complete(completion))
    }
    pub fn retry(&mut self, id: &str) -> Result<Ts<PreviewState>, JsValue> {
        self.preview
            .retry(id, js_sys::Date::now() as u64)
            .map_err(editor_error)?
            .into_ts()
            .map_err(invalid_request)
    }
    pub fn events(&mut self) -> Result<Vec<Ts<PreviewEvent>>, JsValue> {
        self.preview
            .take_events()
            .into_iter()
            .map(|event| event.into_ts().map_err(invalid_request))
            .collect()
    }
    pub fn invalidate_project(&mut self) {
        self.preview.invalidate_project(js_sys::Date::now() as u64);
    }
    pub fn clear(&mut self) {
        self.preview.clear();
    }
    pub fn link(&self, id: &str, task_id: &str, target: &str) -> Result<Ts<PreviewLink>, JsValue> {
        self.preview
            .link(id, task_id, target)
            .map_err(editor_error)?
            .into_ts()
            .map_err(invalid_request)
    }
}

/// Worker-owned shared editor with its browser IO Backend.
#[wasm_bindgen]
pub struct EditorBinding {
    core: EditorCore<crate::backend::browser::BrowserBackend>,
    adapter: EditorAdapter,
}
#[wasm_bindgen]
impl EditorBinding {
    pub async fn open(
        identity: String,
        io: js_sys::Function,
        merge_external: bool,
    ) -> Result<EditorBinding, JsValue> {
        let backend = crate::backend::browser::BrowserBackend::new(io, decode(&identity)?);
        Ok(Self {
            adapter: EditorAdapter::default(),
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
        call_editor(&mut self.adapter, &mut self.core, method, params).await
    }
}

/// A real EditorCore with volatile private history for independent debug replicas.
#[wasm_bindgen]
pub struct MemoryEditorBinding {
    core: EditorCore<MemoryBackend>,
    adapter: EditorAdapter,
}
#[wasm_bindgen]
impl MemoryEditorBinding {
    pub async fn open(identity: String) -> Result<MemoryEditorBinding, JsValue> {
        let backend = MemoryBackend::new(decode(&identity)?, || js_sys::Date::now() as u64);
        Ok(Self {
            adapter: EditorAdapter::default(),
            core: EditorCore::open(backend)
                .await
                .map_err(|e| JsValue::from_str(&encode(e)))?,
        })
    }
    pub async fn call(&mut self, method: String, params: String) -> Result<String, JsValue> {
        call_editor(&mut self.adapter, &mut self.core, method, params).await
    }
}

/// A direct Buffer binding: one command produces one result, with no separate
/// notification drain, host, lock wrapper or mutable IO dependency.
#[wasm_bindgen]
pub struct BufferBinding {
    buffer: Buffer,
    adapter: BufferAdapter,
}

#[wasm_bindgen]
impl BufferBinding {
    #[wasm_bindgen(constructor)]
    pub fn new(
        identity: &str,
        peer_id: Option<String>,
        initial: &str,
    ) -> Result<BufferBinding, JsValue> {
        Ok(Self {
            adapter: BufferAdapter::default(),
            buffer: match decode_peer_id(peer_id)? {
                Some(peer_id) => Buffer::with_peer_id(decode(identity)?, peer_id, initial),
                None => Buffer::new(decode(identity)?, initial),
            }
            .map_err(error)?,
        })
    }
    pub fn from_snapshot(packet: &str, peer_id: Option<String>) -> Result<BufferBinding, JsValue> {
        Ok(Self {
            adapter: BufferAdapter::default(),
            buffer: match decode_peer_id(peer_id)? {
                Some(peer_id) => Buffer::from_snapshot_with_peer_id(&decode(packet)?, peer_id),
                None => Buffer::from_snapshot(&decode(packet)?),
            }
            .map_err(error)?,
        })
    }
    pub fn apply(&mut self, command: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.adapter
                .apply(&mut self.buffer, decode(command)?)
                .map_err(error)?,
        ))
    }
    pub fn snapshot(&self) -> String {
        encode(self.buffer.snapshot())
    }
    pub fn peer_id(&self) -> u64 {
        self.buffer.peer_id()
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
                .anchor_at(
                    utf16_to_byte(&self.buffer.text(), offset as usize).map_err(error)?,
                    match affinity {
                        "before" => Affinity::Before,
                        "after" => Affinity::After,
                        _ => {
                            return Err(JsValue::from_str(&encode(serde_json::json!({
                                "code": "invalid_request",
                                "message": "anchor affinity must be before or after"
                            }))));
                        }
                    },
                )
                .map_err(error)?,
        ))
    }
    pub fn resolve_anchor(&self, anchor: &str) -> Result<f64, JsValue> {
        let anchor: Anchor = decode(anchor)?;
        let offset = anchor.to_offset(&self.buffer).map_err(error)?;
        Ok(byte_to_utf16(&self.buffer.text(), offset).map_err(error)? as f64)
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
    mutations: Vec<serde_json::Value>,
}

async fn call_editor<B: Backend>(
    adapter: &mut EditorAdapter,
    core: &mut EditorCore<B>,
    method: String,
    params: String,
) -> Result<String, JsValue> {
    let outcome = match adapter.call(core, &method, decode(&params)?).await {
        Ok(value) => CallOutcome::Ok { value },
        Err(error) => CallOutcome::Error { error },
    };
    // Even a failing save/refresh may have accepted an external text update.
    // Return those effects before the JS adapter handles the command's error.
    Ok(encode(CallReply {
        outcome,
        mutations: adapter
            .take_mutations(core)
            .map_err(|e| JsValue::from_str(&encode(e)))?,
    }))
}
