//! Browser filesystem bridge; storage formats and recovery policy stay in core.
use super::{FileEntry, FileSnapshot, FileSystem, WriteMode};
use crate::error::{EditorError, EditorResult, ErrorCode};
use js_sys::{Function, Promise};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

pub struct BrowserFileSystem {
    io: Function,
}
impl BrowserFileSystem {
    pub fn new(io: Function) -> Self {
        Self { io }
    }
    async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> EditorResult<T> {
        let request = serde_json::to_string(&json!({"method":method,"params":params})).unwrap();
        let promise = self
            .io
            .call1(&JsValue::NULL, &JsValue::from_str(&request))
            .map_err(|e| EditorError::new(ErrorCode::Io, format!("Browser bridge: {e:?}"), ""))?;
        let result = JsFuture::from(Promise::resolve(&promise))
            .await
            .map_err(|e| EditorError::new(ErrorCode::Io, format!("Browser bridge: {e:?}"), ""))?;
        let response: Value = serde_json::from_str(
            &result
                .as_string()
                .ok_or_else(|| EditorError::new(ErrorCode::Io, "Invalid IO reply", ""))?,
        )
        .map_err(|e| EditorError::new(ErrorCode::Io, e.to_string(), ""))?;
        if let Some(error) = response.get("error") {
            return Err(serde_json::from_value(error.clone())
                .map_err(|e| EditorError::new(ErrorCode::Io, e.to_string(), ""))?);
        }
        serde_json::from_value(response["result"].clone())
            .map_err(|e| EditorError::new(ErrorCode::Io, e.to_string(), ""))
    }
}
impl FileSystem for BrowserFileSystem {
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        self.call("stat", json!({"path":path})).await
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        self.call("readDir", json!({"path":path})).await
    }
    async fn read_file(&self, path: &str, limit: Option<u64>) -> EditorResult<FileSnapshot> {
        self.call("readFile", json!({"path":path,"limit":limit}))
            .await
    }
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mode: WriteMode,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        self.call(
            "writeFile",
            json!({"path":path,"data":data,"mode":mode,"expected":expected}),
        )
        .await
    }
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.call("mkdir", json!({"path":path,"recursive":recursive}))
            .await
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        self.call("rename", json!({"from":from,"to":to})).await
    }
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.call("remove", json!({"path":path,"recursive":recursive}))
            .await
    }
}
