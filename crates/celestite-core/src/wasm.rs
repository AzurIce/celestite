//! Thin WASM bindings for the shared kernel.
//! JSON keeps 64-bit peer IDs as strings.
use crate::*;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, mpsc::Receiver};
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

/// Worker-owned shared editor with its concrete OPFS Backend.
#[wasm_bindgen]
pub struct EditorBinding {
    core: EditorCore<crate::opfs::OpfsBackend>,
}
#[wasm_bindgen]
impl EditorBinding {
    pub async fn open(identity: String, io: js_sys::Function) -> Result<EditorBinding, JsValue> {
        let backend = crate::opfs::OpfsBackend::new(io, decode(&identity)?);
        Ok(Self {
            core: EditorCore::open(backend)
                .await
                .map_err(|e| JsValue::from_str(&encode(e)))?,
        })
    }
    pub async fn execute(&mut self, method: String, params: String) -> Result<String, JsValue> {
        self.core
            .execute_service(&method, decode(&params)?)
            .await
            .map(encode)
            .map_err(|e| JsValue::from_str(&encode(e)))
    }
}

#[wasm_bindgen]
pub struct DocumentBinding {
    document: Arc<Mutex<Document>>,
    events: Receiver<ChangeEvent>,
}

#[wasm_bindgen]
impl DocumentBinding {
    #[wasm_bindgen(constructor)]
    pub fn new(
        identity: &str,
        writer: Option<String>,
        initial: &str,
    ) -> Result<DocumentBinding, JsValue> {
        let mut document =
            Document::new(decode(identity)?, peer(writer)?, initial).map_err(error)?;
        let events = document.subscribe();
        Ok(Self {
            document: Arc::new(Mutex::new(document)),
            events,
        })
    }

    pub fn from_snapshot(packet: &str, writer: Option<String>) -> Result<DocumentBinding, JsValue> {
        let mut document =
            Document::from_snapshot(&decode(packet)?, peer(writer)?).map_err(error)?;
        let events = document.subscribe();
        Ok(Self {
            document: Arc::new(Mutex::new(document)),
            events,
        })
    }
    pub fn snapshot(&self) -> String {
        encode(self.document.lock().unwrap().snapshot())
    }
    pub fn writer_id(&self) -> String {
        self.document.lock().unwrap().writer_id()
    }
    pub fn encoded_version(&self) -> Result<Vec<u8>, JsValue> {
        self.document
            .lock()
            .unwrap()
            .version()
            .encode()
            .map_err(error)
    }
    pub fn decode_version(&self, bytes: &[u8]) -> Result<String, JsValue> {
        Ok(encode(
            Version::decode(self.document.lock().unwrap().identity().clone(), bytes)
                .map_err(error)?,
        ))
    }
    pub fn import_binary(
        &mut self,
        identity: &str,
        bytes: &[u8],
        origin: String,
    ) -> Result<String, JsValue> {
        let packet = SyncPacket::from_binary(decode(identity)?, bytes.to_vec()).map_err(error)?;
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .import(&packet, origin)
                .map_err(error)?,
        ))
    }
    pub fn undo_state(&self) -> String {
        encode(self.document.lock().unwrap().undo_state())
    }
    pub fn transact(&mut self, transaction: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .transact(decode(transaction)?)
                .map_err(error)?,
        ))
    }
    pub fn undo(&mut self, metadata: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .undo_with_context(decode(metadata)?)
                .map_err(error)?,
        ))
    }
    pub fn redo(&mut self, metadata: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .redo_with_context(decode(metadata)?)
                .map_err(error)?,
        ))
    }
    pub fn begin_undo_group(&mut self) -> Result<(), JsValue> {
        self.document
            .lock()
            .unwrap()
            .begin_undo_group()
            .map_err(error)
    }
    pub fn end_undo_group(&mut self) {
        self.document.lock().unwrap().end_undo_group();
    }
    pub fn clear_undo(&mut self) {
        self.document.lock().unwrap().clear_undo();
    }
    pub fn export_snapshot(&self) -> Result<String, JsValue> {
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .export_snapshot()
                .map_err(error)?,
        ))
    }
    pub fn export_updates_since(&self, version: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .export_updates_since(&decode(version)?)
                .map_err(error)?,
        ))
    }
    pub fn import_updates(&mut self, packet: &str, origin: String) -> Result<String, JsValue> {
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .import(&decode(packet)?, origin)
                .map_err(error)?,
        ))
    }
    pub fn anchor_at(&self, offset: f64, affinity: &str) -> Result<String, JsValue> {
        // A direct JS -> usize binding silently truncates fractions and wraps
        // large offsets before the kernel can validate them.
        if !offset.is_finite()
            || offset.fract() != 0.0
            || offset < 0.0
            || offset > usize::MAX as f64
        {
            return Err(JsValue::from_str(&encode(serde_json::json!({
                "code": "invalid_request", "message": "anchor offset must be a non-negative integer within the platform index range"
            }))));
        }
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .anchor_at(offset as usize, decode(affinity)?)
                .map_err(error)?,
        ))
    }
    pub fn resolve_anchor(&self, anchor: &str) -> Result<String, JsValue> {
        Ok(encode(
            self.document
                .lock()
                .unwrap()
                .resolve_anchor(&decode(anchor)?)
                .map_err(error)?,
        ))
    }
    /// Drain only after a mutating call returns, so host callbacks cannot
    /// reenter the same borrowed Wasm object during a commit.
    pub fn take_events(&self) -> String {
        encode(self.events.try_iter().collect::<Vec<_>>())
    }
}
