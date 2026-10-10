//! Browser IO adapter. JS exposes file and private-history primitives; legacy storage is decoded here.
use super::{
    Backend, DirectoryIntent, DocumentHeader, EditorError, EditorResult, FileEntry, FileSnapshot,
    JournalEntry, PendingWrite, StoredDocument, WritePhase,
};
use crate::editor::validate_editor_path;
use crate::instance::InstanceIdentity;
use celestite_buffer::Buffer;
use celestite_buffer::types::{DocumentIdentity, HistoryPacket, HistoryPacketKind, Version};
use js_sys::{Function, Promise};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

pub struct BrowserBackend {
    io: Function,
    identity: InstanceIdentity,
    entries: Vec<Entry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    history_id: String,
    path: String,
    deleted: bool,
}
#[derive(Deserialize)]
struct Catalog {
    schema: u32,
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
struct Head {
    sequence: u64,
    version: Version,
    #[serde(default)]
    header: Option<DocumentHeader>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    saved_content: String,
    disk_revision: String,
    bom: bool,
    line_ending: String,
}
#[derive(Serialize, Deserialize)]
struct UpdateMeta {
    applied: Version,
    kind: HistoryPacketKind,
}

impl BrowserBackend {
    pub fn new(io: Function, identity: InstanceIdentity) -> Self {
        Self {
            io,
            identity,
            entries: vec![],
        }
    }
    async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> EditorResult<T> {
        let request = serde_json::to_string(&json!({"method":method,"params":params})).unwrap();
        let promise = self
            .io
            .call1(&JsValue::NULL, &JsValue::from_str(&request))
            .map_err(|e| EditorError::new("IO", format!("Browser bridge: {e:?}"), ""))?;
        let result = JsFuture::from(Promise::resolve(&promise))
            .await
            .map_err(|e| EditorError::new("IO", format!("Browser bridge: {e:?}"), ""))?;
        let response: Value = serde_json::from_str(
            &result
                .as_string()
                .ok_or_else(|| EditorError::new("IO", "Invalid IO reply", ""))?,
        )
        .map_err(|e| EditorError::new("IO", e.to_string(), ""))?;
        if let Some(error) = response.get("error") {
            return Err(serde_json::from_value(error.clone())
                .map_err(|e| EditorError::new("IO", e.to_string(), ""))?);
        }
        serde_json::from_value(response["result"].clone())
            .map_err(|e| EditorError::new("IO", e.to_string(), ""))
    }
    async fn read_json<T: DeserializeOwned>(&self, path: &str) -> EditorResult<Option<T>> {
        self.call("readJson", json!({"path":path})).await
    }
    async fn write_json(&self, path: &str, data: impl Serialize) -> EditorResult<()> {
        self.call("writeJson", json!({"path":path,"data":data}))
            .await
    }
    async fn bytes(&self, path: &str) -> EditorResult<Option<Vec<u8>>> {
        self.call("readHistory", json!({"path":path})).await
    }
    async fn write(&self, path: &str, data: &[u8]) -> EditorResult<()> {
        self.call("writeHistory", json!({"path":path,"data":data}))
            .await
    }
}
impl Backend for BrowserBackend {
    fn identity(&self) -> &InstanceIdentity {
        &self.identity
    }
    fn persistent(&self) -> bool {
        true
    }
    fn has_projection(&self) -> bool {
        true
    }
    fn new_id(&self) -> EditorResult<String> {
        // Kept outside document semantics; the bridge supplies platform entropy.
        self.io
            .call1(
                &JsValue::NULL,
                &JsValue::from_str("{\"method\":\"newId\",\"params\":{}}"),
            )
            .ok()
            .and_then(|value| value.as_string())
            .ok_or_else(|| {
                EditorError::new("IO", "Platform could not create a document identity", "")
            })
    }
    fn now_ms(&self) -> u64 {
        js_sys::Date::now() as u64
    }
    async fn load(&mut self) -> EditorResult<Vec<StoredDocument>> {
        let catalog: Option<Catalog> = self.read_json("catalog.json").await?;
        if let Some(catalog) = catalog {
            if catalog.schema != 1 {
                return Err(EditorError::new("IO", "Unsupported catalog schema", ""));
            }
            self.entries = catalog.entries;
        }
        let mut records = vec![];
        let mut ids = std::collections::BTreeSet::new();
        for entry in &self.entries {
            if !valid_id(&entry.id) || !valid_id(&entry.history_id) || !ids.insert(&entry.id) {
                return Err(EditorError::new(
                    "IO",
                    "Invalid browser catalog identity",
                    &entry.path,
                ));
            }
            validate_editor_path(&entry.path)?;
            let dir = format!("documents/{}", entry.id);
            let head: Head = self
                .read_json(&format!("{dir}/head.json"))
                .await?
                .ok_or_else(|| {
                    EditorError::new("IO", "Missing committed history head", &entry.path)
                })?;
            let seed = self
                .bytes(&format!("{dir}/seed.bin"))
                .await?
                .ok_or_else(|| EditorError::new("IO", "Missing document seed", &entry.path))?;
            let identity = DocumentIdentity {
                document_id: entry.id.clone(),
                history_id: entry.history_id.clone(),
            };
            let packet = HistoryPacket {
                identity,
                kind: HistoryPacketKind::Snapshot,
                data: seed.into(),
            };
            let mut legacy: Option<Buffer> = None;
            let mut journal = vec![];
            for sequence in 1..=head.sequence {
                let data = self
                    .bytes(&format!("{dir}/updates/{sequence}.bin"))
                    .await?
                    .ok_or_else(|| {
                        EditorError::new("IO", "Missing committed update", &entry.path)
                    })?;
                let meta: Option<UpdateMeta> = self
                    .read_json(&format!("{dir}/updates/{sequence}.meta.json"))
                    .await?;
                let update = HistoryPacket {
                    identity: packet.identity.clone(),
                    kind: meta.as_ref().map_or(HistoryPacketKind::Updates, |m| m.kind),
                    data: data.into(),
                };
                let applied = if let Some(meta) = meta {
                    if let Some(doc) = legacy.as_mut() {
                        let _ = doc.import(update.clone())?;
                    }
                    meta.applied
                } else {
                    if legacy.is_none() {
                        let mut doc = Buffer::from_snapshot(&packet)?;
                        for prior in &journal {
                            let prior: &JournalEntry = prior;
                            let _ = doc.import(prior.packet.clone())?;
                        }
                        legacy = Some(doc);
                    }
                    let doc = legacy.as_mut().unwrap();
                    let _ = doc.import(update.clone())?;
                    doc.version()
                };
                journal.push(JournalEntry {
                    packet: update,
                    applied,
                });
            }
            let header = if let Some(header) = head.header {
                header
            } else {
                let receipt: Receipt = self
                    .read_json(&format!("{dir}/projection.json"))
                    .await?
                    .ok_or_else(|| EditorError::new("IO", "Missing file baseline", &entry.path))?;
                let intent: Option<Receipt> =
                    self.read_json(&format!("{dir}/save-intent.json")).await?;
                DocumentHeader {
                    id: entry.id.clone(),
                    path: entry.path.clone(),
                    seed: packet.clone(),
                    sequence: head.sequence,
                    applied: head.version.clone(),
                    saved_text: receipt.saved_content,
                    disk_revision: receipt.disk_revision,
                    saved_version: None,
                    pending_write: intent.map(|i| PendingWrite {
                        text: i.saved_content,
                        version: None,
                        phase: WritePhase::Legacy,
                        id: None,
                        expected_revision: None,
                    }),
                    disk_cursor: None,
                    deleted: entry.deleted,
                    bom: receipt.bom,
                    line_ending: receipt.line_ending,
                }
            };
            if header.seed.kind != packet.kind
                || header.seed.identity != packet.identity
                || header.seed.data != packet.data
                || header.id != entry.id
                || header.seed.identity.history_id != entry.history_id
                || header.sequence != head.sequence
                || header.applied != head.version
            {
                return Err(EditorError::new(
                    "IO",
                    "Stored browser history identity/version mismatch",
                    &entry.path,
                ));
            }
            records.push((header, journal));
        }
        Ok(records)
    }
    async fn commit(
        &mut self,
        header: &DocumentHeader,
        entry: Option<&JournalEntry>,
    ) -> EditorResult<()> {
        let dir = format!("documents/{}", header.id);
        if !self.entries.iter().any(|e| e.id == header.id) {
            self.write(&format!("{dir}/seed.bin"), &header.seed.data)
                .await?;
        }
        if let Some(entry) = entry {
            self.write(
                &format!("{dir}/updates/{}.bin", header.sequence),
                &entry.packet.data,
            )
            .await?;
            self.write_json(
                &format!("{dir}/updates/{}.meta.json", header.sequence),
                UpdateMeta {
                    applied: entry.applied.clone(),
                    kind: entry.packet.kind,
                },
            )
            .await?;
        }
        self.write_json(
            &format!("{dir}/head.json"),
            json!({"sequence":header.sequence,"version":header.applied,"header":header}),
        )
        .await?;
        let mut catalog = self.entries.clone();
        let next = Entry {
            id: header.id.clone(),
            history_id: header.seed.identity.history_id.clone(),
            path: header.path.clone(),
            deleted: header.deleted,
        };
        if let Some(entry) = catalog.iter_mut().find(|e| e.id == header.id) {
            *entry = next;
        } else {
            catalog.push(next);
        }
        if serde_json::to_value(&catalog).unwrap() != serde_json::to_value(&self.entries).unwrap() {
            self.write_json("catalog.json", json!({"schema":1,"entries":catalog}))
                .await?;
            self.entries = catalog;
        }
        Ok(())
    }
    async fn directory_intent(&mut self) -> EditorResult<Option<DirectoryIntent>> {
        if let Some(intent) = self.read_json("directory-intent.json").await? {
            return Ok(Some(intent));
        }
        if let Some(intent) = self.read_json::<Value>("rename-intent.json").await? {
            let entries: Vec<(String, String)> = intent["entries"]
                .as_array()
                .ok_or_else(|| EditorError::new("IO", "Invalid legacy move intent", ""))?
                .iter()
                .map(|e| {
                    serde_json::from_value(json!([e["id"], e["path"]]))
                        .map_err(|e| EditorError::new("IO", e.to_string(), ""))
                })
                .collect::<EditorResult<_>>()?;
            return Ok(Some(DirectoryIntent {
                operation: "rename".into(),
                from: intent["from"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("IO", "Invalid move source", ""))?
                    .into(),
                to: Some(
                    intent["to"]
                        .as_str()
                        .ok_or_else(|| EditorError::new("IO", "Invalid move destination", ""))?
                        .into(),
                ),
                entries,
            }));
        }
        if let Some(intent) = self.read_json::<Value>("remove-intent.json").await? {
            let entries = intent["paths"]
                .as_array()
                .ok_or_else(|| EditorError::new("IO", "Invalid legacy removal intent", ""))?
                .iter()
                .map(|e| {
                    serde_json::from_value(json!([e["id"], e["path"]]))
                        .map_err(|e| EditorError::new("IO", e.to_string(), ""))
                })
                .collect::<EditorResult<Vec<_>>>()?;
            return Ok(Some(DirectoryIntent {
                operation: "remove".into(),
                from: String::new(),
                to: None,
                entries,
            }));
        }
        Ok(None)
    }
    async fn set_directory_intent(&mut self, intent: Option<&DirectoryIntent>) -> EditorResult<()> {
        self.write_json("directory-intent.json", intent).await?;
        if intent.is_none() {
            self.write_json("rename-intent.json", Value::Null).await?;
            self.write_json("remove-intent.json", Value::Null).await?;
        }
        Ok(())
    }
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
        mode: &str,
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

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
