//! Shared editor business: platform adapters implement IO, never save/recovery policy.
use crate::{backend::*, *};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;

struct Record {
    header: DocumentHeader,
    document: Document,
    pending_packets: Vec<SyncPacket>,
    uncommitted: Vec<JournalEntry>,
    durable: Option<Version>,
    conflict: bool,
    error: Option<String>,
    last_group: String,
    last_edit: u64,
    first_dirty: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub id: String,
    pub path: String,
    pub snapshot: TextSnapshot,
    pub undo: UndoState,
    pub writer_id: String,
    pub saved_content: String,
    pub bom: bool,
    pub line_ending: String,
    pub dirty: bool,
    pub deleted: bool,
    pub conflict: bool,
    pub backend_revision: String,
    pub saved_version: Option<Version>,
    pub durable_version: Option<Version>,
    pub persistence_error: Option<String>,
    pub error: Option<String>,
    pub autosave_delay: Option<u64>,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionContext {
    pub ranges: Vec<SelectionRange>,
    pub main_index: usize,
}
#[derive(Deserialize, Serialize)]
pub struct SelectionRange {
    pub anchor: usize,
    pub head: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorEditResult {
    pub document: EditorDocument,
    pub edits: Vec<TextEdit>,
    pub restored_selection: Option<SelectionContext>,
}

pub struct EditorCore<B: Backend> {
    backend: B,
    records: BTreeMap<String, Record>,
    failure: Option<String>,
}

pub fn validate_editor_path(path: &str) -> EditorResult<()> {
    if path.contains(['\\', '\0'])
        || path.starts_with('/')
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
        || (!path.is_empty()
            && path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".."))
    {
        return Err(EditorError::new(
            "InvalidPath",
            "Expected a Vault-relative path",
            path,
        ));
    }
    Ok(())
}
fn within(path: &str, root: &str) -> bool {
    root.is_empty()
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('/'))
}
fn validate_text(text: &str, path: &str) -> EditorResult<()> {
    if text.chars().any(|c| c < ' ' && !matches!(c, '\n' | '\t')) {
        return Err(EditorError::new(
            "InvalidEdit",
            "Text uses LF; binary control characters are not accepted",
            path,
        ));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", path));
    }
    Ok(())
}
fn decode(bytes: &[u8], path: &str) -> EditorResult<(String, bool, String)> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", path));
    }
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let raw = std::str::from_utf8(if bom { &bytes[3..] } else { bytes })
        .map_err(|_| EditorError::new("Unsupported", "Not a UTF-8 text file", path))?;
    if raw
        .chars()
        .any(|c| c < ' ' && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(EditorError::new(
            "Unsupported",
            "Not an editable text file",
            path,
        ));
    }
    let ending = raw
        .find(['\r', '\n'])
        .map(|i| {
            if raw[i..].starts_with("\r\n") {
                "\r\n"
            } else if raw[i..].starts_with('\r') {
                "\r"
            } else {
                "\n"
            }
        })
        .unwrap_or("\n")
        .to_string();
    Ok((raw.replace("\r\n", "\n").replace('\r', "\n"), bom, ending))
}
fn encode(header: &DocumentHeader, text: &str) -> Vec<u8> {
    format!(
        "{}{}",
        if header.bom { "\u{feff}" } else { "" },
        text.replace('\n', &header.line_ending)
    )
    .into_bytes()
}

impl<B: Backend> EditorCore<B> {
    pub async fn open(mut backend: B) -> EditorResult<Self> {
        let identity = backend.identity();
        if identity.instance_id.is_empty()
            || identity.vault.vault_id.is_empty()
            || identity.vault.history_id.is_empty()
        {
            return Err(EditorError::new("IO", "Invalid instance identity", ""));
        }
        let mut records = BTreeMap::new();
        let mut paths = std::collections::BTreeSet::new();
        for (header, journal) in backend.load().await? {
            validate_editor_path(&header.path)?;
            if header.id != header.seed.identity.document_id
                || records.contains_key(&header.id)
                || (!header.deleted && !paths.insert(header.path.clone()))
                || journal.len() as u64 != header.sequence
                || !matches!(header.line_ending.as_str(), "\n" | "\r" | "\r\n")
            {
                return Err(EditorError::new(
                    "IO",
                    "Invalid stored document identity or journal",
                    &header.path,
                ));
            }
            let mut document = Document::from_snapshot(&header.seed, None)?;
            let mut pending_packets = vec![];
            for entry in journal {
                let result = document.import(&entry.packet, "recovery".into())?;
                if result.pending {
                    pending_packets.push(entry.packet);
                }
                if document.version() != entry.applied {
                    return Err(EditorError::new(
                        "IO",
                        "Recovered journal version mismatch",
                        &header.path,
                    ));
                }
            }
            validate_text(&document.snapshot().text, &header.path)?;
            if document.version() != header.applied {
                return Err(EditorError::new(
                    "IO",
                    "Recovered document version mismatch",
                    &header.path,
                ));
            }
            let durable = backend.persistent().then(|| header.applied.clone());
            records.insert(
                header.id.clone(),
                Record {
                    header,
                    document,
                    pending_packets,
                    uncommitted: vec![],
                    durable,
                    conflict: false,
                    error: None,
                    last_group: String::new(),
                    last_edit: 0,
                    first_dirty: None,
                },
            );
        }
        let mut core = Self {
            backend,
            records,
            failure: None,
        };
        core.recover_directory().await?;
        Ok(core)
    }
    pub fn identity(&self) -> &InstanceIdentity {
        self.backend.identity()
    }
    pub fn persistent(&self) -> bool {
        self.backend.persistent()
    }
    fn record(&self, id: &str) -> EditorResult<&Record> {
        self.records
            .get(id)
            .ok_or_else(|| EditorError::new("NotFound", "Document not found", id))
    }
    fn writable(&self) -> EditorResult<()> {
        if let Some(error) = &self.failure {
            return Err(EditorError::new("IO", error, ""));
        }
        Ok(())
    }
    fn live(&self, id: &str) -> EditorResult<()> {
        self.writable()?;
        if self.record(id)?.header.deleted {
            return Err(EditorError::new(
                "NotFound",
                "Document was deleted; its history is retained",
                id,
            ));
        }
        Ok(())
    }
    pub fn read(&self, id: &str) -> EditorResult<EditorDocument> {
        let record = self.record(id)?;
        let header = &record.header;
        let snapshot = record.document.snapshot();
        let dirty = snapshot.text != header.saved_text;
        Ok(EditorDocument {
            id: id.into(),
            path: header.path.clone(),
            undo: record.document.undo_state(),
            writer_id: record.document.writer_id(),
            saved_content: header.saved_text.clone(),
            bom: header.bom,
            line_ending: header.line_ending.clone(),
            dirty,
            deleted: header.deleted,
            conflict: record.conflict,
            backend_revision: header.disk_revision.clone(),
            saved_version: header.saved_version.clone(),
            durable_version: record.durable.clone(),
            persistence_error: self.failure.clone(),
            error: record.error.clone(),
            autosave_delay: if dirty
                && self.backend.has_projection()
                && !header.deleted
                && !record.conflict
                && record.error.is_none()
                && self.failure.is_none()
            {
                Some(
                    800.min(
                        5000_u64.saturating_sub(
                            self.backend.now_ms().saturating_sub(
                                record.first_dirty.unwrap_or(self.backend.now_ms()),
                            ),
                        ),
                    ),
                )
            } else {
                None
            },
            snapshot,
        })
    }
    fn queue_packet(&mut self, id: &str, packet: SyncPacket) {
        let record = self.records.get_mut(id).unwrap();
        record.uncommitted.push(JournalEntry {
            packet,
            applied: record.document.version(),
        });
        if record.document.snapshot().text != record.header.saved_text
            && record.first_dirty.is_none()
        {
            record.first_dirty = Some(self.backend.now_ms());
        }
    }
    async fn persist(&mut self, id: &str) -> EditorResult<()> {
        loop {
            let record = self.record(id)?;
            let entry = record.uncommitted.first().cloned();
            let mut header = record.header.clone();
            if let Some(entry) = &entry {
                header.sequence += 1;
                header.applied = entry.applied.clone();
            }
            if let Err(error) = self.backend.commit(&header, entry.as_ref()).await {
                self.failure = Some(format!("编辑历史尚未持久化：{}", error.message));
                return Err(error);
            }
            let record = self.records.get_mut(id).unwrap();
            record.header = header;
            record.durable = self
                .backend
                .persistent()
                .then(|| record.header.applied.clone());
            if entry.is_some() {
                record.uncommitted.remove(0);
            }
            if record.uncommitted.is_empty() {
                break;
            }
        }
        Ok(())
    }
    pub async fn retry_history(&mut self) -> EditorResult<()> {
        let ids: Vec<_> = self.records.keys().cloned().collect();
        for id in ids {
            self.persist(&id).await?;
        }
        self.failure = None;
        Ok(())
    }
    pub async fn open_file(&mut self, path: &str) -> EditorResult<String> {
        validate_editor_path(path)?;
        if let Some(id) = self
            .records
            .values()
            .find(|r| !r.header.deleted && r.header.path == path)
            .map(|r| r.header.id.clone())
        {
            self.refresh(&id).await?;
            return Ok(id);
        }
        self.writable()?;
        let disk = self
            .backend
            .read_file(path, Some(MAX_TEXT_BYTES as u64))
            .await?;
        let (text, bom, line_ending) = decode(&disk.data, path)?;
        let identity = DocumentIdentity {
            document_id: self.backend.new_id()?,
            history_id: self.backend.new_id()?,
        };
        let document = Document::new(identity.clone(), None, &text)?;
        let header = DocumentHeader {
            id: identity.document_id.clone(),
            path: path.into(),
            seed: document.export_snapshot()?,
            sequence: 0,
            applied: document.version(),
            saved_text: text,
            disk_revision: disk.revision,
            saved_version: Some(document.version()),
            pending_write: None,
            deleted: false,
            bom,
            line_ending,
        };
        self.records.insert(
            header.id.clone(),
            Record {
                header,
                document,
                uncommitted: vec![],
                pending_packets: vec![],
                durable: None,
                conflict: false,
                error: None,
                last_group: String::new(),
                last_edit: 0,
                first_dirty: None,
            },
        );
        self.persist(&identity.document_id).await?;
        Ok(identity.document_id)
    }
    pub async fn list(&mut self) -> EditorResult<Vec<EditorDocument>> {
        let mut pending = vec![String::new()];
        while let Some(directory) = pending.pop() {
            for entry in self.backend.read_dir(&directory).await? {
                if entry.kind == "directory" {
                    pending.push(entry.path);
                } else if entry.kind == "file" {
                    match self.open_file(&entry.path).await {
                        Ok(_) => {}
                        Err(error) if matches!(error.code.as_str(), "Unsupported" | "NotFound") => {
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        let ids: Vec<_> = self.records.keys().cloned().collect();
        let mut states = vec![];
        for id in ids {
            self.refresh(&id).await?;
            if !self.record(&id)?.header.deleted {
                states.push(self.read(&id)?);
            }
        }
        states.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(states)
    }
    pub async fn refresh_path(&mut self, path: &str) -> EditorResult<()> {
        if let Some(id) = self
            .records
            .values()
            .find(|r| !r.header.deleted && r.header.path == path)
            .map(|r| r.header.id.clone())
        {
            self.refresh(&id).await?;
        }
        Ok(())
    }
    pub async fn refresh(&mut self, id: &str) -> EditorResult<()> {
        let record = self.record(id)?;
        if !self.backend.has_projection() || record.header.deleted || self.failure.is_some() {
            return Ok(());
        }
        let disk = match self
            .backend
            .read_file(&record.header.path, Some(MAX_TEXT_BYTES as u64))
            .await
        {
            Ok(disk) => disk,
            Err(error) if matches!(error.code.as_str(), "NotFound" | "NotFile" | "Unsupported") => {
                let record = self.records.get_mut(id).unwrap();
                record.conflict = true;
                record.error = Some(error.message);
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        self.recover_completed_write(id, &disk).await?;
        let record = self.record(id)?;
        if disk.revision == record.header.disk_revision {
            let record = self.records.get_mut(id).unwrap();
            record.conflict = false;
            return Ok(());
        }
        if record.document.snapshot().text != record.header.saved_text {
            let record = self.records.get_mut(id).unwrap();
            record.conflict = true;
            record.error = Some("文件已在外部修改，本地编辑仍保留。".into());
            return Ok(());
        }
        let (text, bom, ending) = decode(&disk.data, &record.header.path)?;
        self.adopt_disk(id, text, bom, ending, disk.revision, false)
            .await
    }
    async fn recover_completed_write(&mut self, id: &str, disk: &FileSnapshot) -> EditorResult<()> {
        if let Some(pending) = &self.record(id)?.header.pending_write
            && encode(&self.record(id)?.header, &pending.text) == disk.data
        {
            let pending = pending.clone();
            let record = self.records.get_mut(id).unwrap();
            record.header.saved_text = pending.text;
            record.header.saved_version = pending.version;
            record.header.disk_revision = disk.revision.clone();
            record.header.pending_write = None;
            record.conflict = false;
            record.error = None;
            if record.document.snapshot().text == record.header.saved_text {
                record.first_dirty = None;
            }
            self.persist(id).await?;
        }
        Ok(())
    }
    async fn adopt_disk(
        &mut self,
        id: &str,
        text: String,
        bom: bool,
        ending: String,
        revision: String,
        clear_undo: bool,
    ) -> EditorResult<()> {
        let record = self.record(id)?;
        let before = record.document.version();
        let mut external = Document::from_snapshot(&record.document.export_snapshot()?, None)?;
        external.transact(Transaction {
            expected_version: external.version(),
            origin: "filesystem".into(),
            edits: text_difference(&external.snapshot().text, &text),
            undo_metadata: None,
            undo_positions: vec![],
        })?;
        let packet = external.export_updates_since(&before)?;
        let record = self.records.get_mut(id).unwrap();
        record.document.import(&packet, "filesystem".into())?;
        if clear_undo {
            record.document.end_undo_group();
            record.document.clear_undo();
            record.last_group.clear();
        }
        record.header.saved_text = text;
        record.header.saved_version = Some(record.document.version());
        record.header.disk_revision = revision;
        record.header.bom = bom;
        record.header.line_ending = ending;
        record.header.pending_write = None;
        record.conflict = false;
        record.error = None;
        record.first_dirty = None;
        self.queue_packet(id, packet);
        self.persist(id).await
    }
    fn apply_transaction(
        &mut self,
        id: &str,
        transaction: Transaction,
    ) -> EditorResult<Option<ChangeEvent>> {
        self.live(id)?;
        let record = self.record(id)?;
        let before = record.document.version();
        if transaction.expected_version != before {
            return Err(CoreError::StaleVersion.into());
        }
        let text = record.document.snapshot().text;
        let mut size = text.len();
        for edit in &transaction.edits {
            validate_text(&edit.insert, id)?;
            let from = utf16_to_byte(&text, edit.from)?;
            let to = utf16_to_byte(&text, edit.to)?;
            size = size
                .checked_sub(to.saturating_sub(from))
                .and_then(|n| n.checked_add(edit.insert.len()))
                .ok_or_else(|| EditorError::new("InvalidEdit", "Invalid edit size", id))?;
        }
        if size > MAX_TEXT_BYTES {
            return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", id));
        }
        let record = self.records.get_mut(id).unwrap();
        let event = record.document.transact(transaction)?;
        if record.document.version() != before {
            let packet = record.document.export_updates_since(&before)?;
            self.queue_packet(id, packet);
        }
        Ok(event)
    }
    pub async fn transact(
        &mut self,
        id: &str,
        transaction: Transaction,
    ) -> EditorResult<Option<ChangeEvent>> {
        let event = self.apply_transaction(id, transaction)?;
        if !self.record(id)?.uncommitted.is_empty() {
            self.persist(id).await?;
        }
        Ok(event)
    }
    pub async fn edit(
        &mut self,
        id: &str,
        version: Version,
        edits: Vec<TextEdit>,
        context: SelectionContext,
        user_event: String,
    ) -> EditorResult<EditorEditResult> {
        self.live(id)?;
        let now = self.backend.now_ms();
        let group = if user_event.starts_with("input.type") || user_event.starts_with("delete.") {
            user_event.clone()
        } else {
            String::new()
        };
        let record = self.records.get_mut(id).unwrap();
        if group.is_empty()
            || group != record.last_group
            || now.saturating_sub(record.last_edit) > 500
        {
            record.document.end_undo_group();
            if !group.is_empty() {
                record.document.begin_undo_group()?;
            }
        }
        let event = self.apply_transaction(
            id,
            Transaction {
                expected_version: version,
                edits,
                origin: user_event,
                undo_metadata: Some(serde_json::json!({"mainIndex":context.main_index})),
                undo_positions: context
                    .ranges
                    .iter()
                    .flat_map(|r| [r.anchor, r.head])
                    .collect(),
            },
        )?;
        let record = self.records.get_mut(id).unwrap();
        record.last_group = group;
        record.last_edit = now;
        // Return accepted text even if IO failed; the UI must retain the draft.
        if !record.uncommitted.is_empty() {
            let _ = self.persist(id).await;
        }
        Ok(EditorEditResult {
            document: self.read(id)?,
            edits: event.map_or(vec![], |e| e.edits),
            restored_selection: None,
        })
    }
    pub async fn import(&mut self, id: &str, packet: SyncPacket) -> EditorResult<ImportResult> {
        self.live(id)?;
        if packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                "Unsupported",
                "CRDT packet exceeds 16 MiB",
                id,
            ));
        }
        let record = self.record(id)?;
        let mut trial = Document::from_snapshot(&record.document.export_snapshot()?, None)?;
        for waiting in &record.pending_packets {
            trial.import(waiting, "validation".into())?;
        }
        trial.import(&packet, "validation".into())?;
        validate_text(&trial.snapshot().text, id)?;
        let record = self.records.get_mut(id).unwrap();
        let result = record.document.import(&packet, "peer".into())?;
        if result.pending {
            record.pending_packets.push(packet.clone());
        }
        self.queue_packet(id, packet);
        self.persist(id).await?;
        Ok(result)
    }
    fn apply_undo(
        &mut self,
        id: &str,
        context: UndoContext,
        redo: bool,
    ) -> EditorResult<Option<ChangeEvent>> {
        self.live(id)?;
        let record = self.records.get_mut(id).unwrap();
        record.document.end_undo_group();
        record.last_group.clear();
        let before = record.document.version();
        let event = if redo {
            record.document.redo_with_context(context)?
        } else {
            record.document.undo_with_context(context)?
        };
        if record.document.version() != before {
            let packet = record.document.export_updates_since(&before)?;
            self.queue_packet(id, packet);
        }
        Ok(event)
    }
    pub async fn undo(
        &mut self,
        id: &str,
        context: UndoContext,
        redo: bool,
    ) -> EditorResult<Option<ChangeEvent>> {
        let event = self.apply_undo(id, context, redo)?;
        if !self.record(id)?.uncommitted.is_empty() {
            self.persist(id).await?;
        }
        Ok(event)
    }
    pub async fn undo_view(
        &mut self,
        id: &str,
        context: SelectionContext,
        redo: bool,
    ) -> EditorResult<EditorEditResult> {
        let event = self.apply_undo(
            id,
            UndoContext {
                metadata: Some(serde_json::json!({"mainIndex":context.main_index})),
                positions: context
                    .ranges
                    .iter()
                    .flat_map(|r| [r.anchor, r.head])
                    .collect(),
            },
            redo,
        )?;
        if !self.record(id)?.uncommitted.is_empty() {
            let _ = self.persist(id).await;
        }
        let selection = event.as_ref().and_then(|e| {
            let ranges: Vec<_> = e
                .restored_positions
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| SelectionRange {
                    anchor: p[0],
                    head: p[1],
                })
                .collect();
            (!ranges.is_empty()).then(|| SelectionContext {
                ranges,
                main_index: e
                    .restored_metadata
                    .as_ref()
                    .and_then(|m| m.get("mainIndex"))
                    .and_then(|m| m.as_u64())
                    .unwrap_or(0) as usize,
            })
        });
        Ok(EditorEditResult {
            document: self.read(id)?,
            edits: event.map_or(vec![], |e| e.edits),
            restored_selection: selection,
        })
    }
    pub fn snapshot(&self, id: &str) -> EditorResult<SyncPacket> {
        Ok(self.record(id)?.document.export_snapshot()?)
    }
    pub fn updates(&self, id: &str, version: &Version) -> EditorResult<SyncPacket> {
        Ok(self.record(id)?.document.export_updates_since(version)?)
    }
    pub async fn save(&mut self, id: &str, expected: Option<Version>) -> EditorResult<()> {
        let result = self.save_inner(id, expected).await;
        if let Err(error) = &result
            && let Some(record) = self.records.get_mut(id)
        {
            record.error = Some(error.message.clone());
            record.conflict = error.code == "Conflict";
        }
        result
    }
    async fn save_inner(&mut self, id: &str, expected: Option<Version>) -> EditorResult<()> {
        if self.failure.is_some() {
            self.retry_history().await?;
        }
        self.live(id)?;
        let record = self.record(id)?;
        if expected.is_some_and(|version| version != record.document.version()) {
            return Err(CoreError::StaleVersion.into());
        }
        if !self.backend.has_projection() {
            return self.persist(id).await;
        }
        let snapshot = record.document.snapshot();
        let path = record.header.path.clone();
        // Even a clean save verifies the external baseline.
        let disk = self
            .backend
            .read_file(&path, Some(MAX_TEXT_BYTES as u64))
            .await?;
        self.recover_completed_write(id, &disk).await?;
        let record = self.record(id)?;
        if disk.revision != record.header.disk_revision {
            let record = self.records.get_mut(id).unwrap();
            record.conflict = true;
            return Err(EditorError::new(
                "Conflict",
                "文件已被其他客户端或程序修改。",
                &path,
            ));
        }
        if snapshot.text == record.header.saved_text {
            let record = self.records.get_mut(id).unwrap();
            record.error = None;
            record.conflict = false;
            record.first_dirty = None;
            return Ok(());
        }
        let bytes = encode(&record.header, &snapshot.text);
        let baseline = record.header.disk_revision.clone();
        self.records.get_mut(id).unwrap().header.pending_write = Some(PendingWrite {
            text: snapshot.text.clone(),
            version: Some(snapshot.version.clone()),
        });
        self.persist(id).await?;
        let revision = match self
            .backend
            .write_file(&path, &bytes, "replace", Some(&baseline))
            .await
        {
            Ok(revision) => revision,
            Err(error) => {
                let record = self.records.get_mut(id).unwrap();
                record.error = Some(error.message.clone());
                record.conflict = error.code == "Conflict";
                return Err(error);
            }
        };
        let record = self.records.get_mut(id).unwrap();
        record.header.saved_text = snapshot.text;
        record.header.saved_version = Some(snapshot.version);
        record.header.disk_revision = revision;
        record.header.pending_write = None;
        record.conflict = false;
        record.error = None;
        record.first_dirty = None;
        self.persist(id).await
    }
    pub async fn resolve(&mut self, id: &str, action: &str) -> EditorResult<()> {
        if self.failure.is_some() {
            self.retry_history().await?;
        }
        self.live(id)?;
        let path = self.record(id)?.header.path.clone();
        let disk = self
            .backend
            .read_file(&path, Some(MAX_TEXT_BYTES as u64))
            .await?;
        match action {
            "discard" => {
                let (text, bom, ending) = decode(&disk.data, &path)?;
                self.adopt_disk(id, text, bom, ending, disk.revision, true)
                    .await
            }
            "overwrite" => {
                self.records.get_mut(id).unwrap().header.disk_revision = disk.revision;
                self.save(id, None).await
            }
            _ => Err(EditorError::new(
                "InvalidEdit",
                "Unknown conflict action",
                &path,
            )),
        }
    }
    pub fn before_replace(&self, path: &str) -> EditorResult<()> {
        self.writable()?;
        if self.records.values().any(|r| {
            !r.header.deleted
                && r.header.path == path
                && r.document.snapshot().text != r.header.saved_text
        }) {
            return Err(EditorError::new(
                "Conflict",
                "File has unsaved CRDT edits; use the document API",
                path,
            ));
        }
        Ok(())
    }
    async fn persist_headers(&mut self) -> EditorResult<()> {
        let ids: Vec<_> = self.records.keys().cloned().collect();
        for id in ids {
            self.persist(&id).await?;
        }
        Ok(())
    }
    async fn finish_directory(&mut self, intent: &DirectoryIntent) -> EditorResult<()> {
        for (id, path) in &intent.entries {
            if let Some(record) = self.records.get_mut(id) {
                if intent.operation == "rename" {
                    record.header.path = format!(
                        "{}{}",
                        intent.to.as_ref().unwrap(),
                        &path[intent.from.len()..]
                    );
                } else if self.backend.stat(path).await?.is_none() {
                    record.header.deleted = true;
                    record.first_dirty = None;
                }
            }
        }
        self.persist_headers().await?;
        self.backend.set_directory_intent(None).await
    }
    async fn recover_directory(&mut self) -> EditorResult<()> {
        let Some(intent) = self.backend.directory_intent().await? else {
            return Ok(());
        };
        validate_editor_path(&intent.from)?;
        for (_, path) in &intent.entries {
            validate_editor_path(path)?;
            if !within(path, &intent.from) {
                return Err(EditorError::new(
                    "IO",
                    "Invalid directory recovery intent",
                    path,
                ));
            }
        }
        if intent.operation == "remove" {
            return self.finish_directory(&intent).await;
        }
        if intent.operation != "rename" || intent.to.is_none() {
            return Err(EditorError::new(
                "IO",
                "Unknown directory recovery intent",
                &intent.from,
            ));
        }
        let to = intent.to.as_ref().unwrap();
        validate_editor_path(to)?;
        let source = self.backend.stat(&intent.from).await?;
        let target = self.backend.stat(to).await?;
        match (source, target) {
            (None, Some(_)) => self.finish_directory(&intent).await,
            (Some(_), None) => self.backend.set_directory_intent(None).await,
            _ => Err(EditorError::new(
                "Conflict",
                "上次移动未完成，源与目标状态存在歧义；文件与历史已保留。",
                &intent.from,
            )),
        }
    }
    pub async fn rename(&mut self, from: &str, to: &str) -> EditorResult<()> {
        self.writable()?;
        validate_editor_path(from)?;
        validate_editor_path(to)?;
        self.recover_directory().await?;
        if from == to && !from.is_empty() {
            return self.backend.rename(from, to).await;
        }
        if from.is_empty() || to.is_empty() || within(to, from) {
            return Err(EditorError::new(
                "InvalidPath",
                "Cannot move root or a directory into itself",
                from,
            ));
        }
        let intent = DirectoryIntent {
            operation: "rename".into(),
            from: from.into(),
            to: Some(to.into()),
            entries: self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, from))
                .map(|r| (r.header.id.clone(), r.header.path.clone()))
                .collect(),
        };
        self.backend.set_directory_intent(Some(&intent)).await?;
        if let Err(error) = self.backend.rename(from, to).await {
            if error
                .rename
                .as_ref()
                .is_some_and(|r| r.phase == "remove-source")
            {
                // Keep the complete target and its identity; retain the intent for
                // an explicit resolution of remaining source files on recovery.
                for (id, path) in &intent.entries {
                    self.records.get_mut(id).unwrap().header.path =
                        format!("{}{}", to, &path[from.len()..]);
                }
                self.persist_headers().await?;
            } else if matches!(
                error.code.as_str(),
                "AlreadyExists" | "InvalidPath" | "Unsupported" | "NotFound"
            ) || (self.backend.stat(from).await?.is_some()
                && self.backend.stat(to).await?.is_none())
            {
                self.backend.set_directory_intent(None).await?;
            }
            return Err(error);
        }
        self.finish_directory(&intent).await
    }
    pub async fn remove(&mut self, path: &str, recursive: bool) -> EditorResult<()> {
        self.writable()?;
        validate_editor_path(path)?;
        self.recover_directory().await?;
        if path.is_empty() {
            return Err(EditorError::new(
                "InvalidPath",
                "Cannot remove Vault root",
                path,
            ));
        }
        let intent = DirectoryIntent {
            operation: "remove".into(),
            from: path.into(),
            to: None,
            entries: self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, path))
                .map(|r| (r.header.id.clone(), r.header.path.clone()))
                .collect(),
        };
        self.backend.set_directory_intent(Some(&intent)).await?;
        let result = self.backend.remove(path, recursive).await;
        self.finish_directory(&intent).await?;
        result
    }
    pub async fn flush(&mut self) -> EditorResult<()> {
        let ids: Vec<_> = self
            .records
            .values()
            .filter(|r| !r.header.deleted)
            .map(|r| r.header.id.clone())
            .collect();
        for id in ids {
            self.save(&id, None).await?;
        }
        Ok(())
    }
    pub async fn file_operation(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> EditorResult<serde_json::Value> {
        let path = params
            .get("path")
            .or_else(|| params.get("from"))
            .and_then(|p| p.as_str())
            .unwrap_or("");
        validate_editor_path(path)?;
        if matches!(method, "readFile" | "writeFile" | "rename" | "remove") {
            let ids: Vec<_> = self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, path))
                .map(|r| r.header.id.clone())
                .collect();
            for id in ids {
                self.save(&id, None).await?;
            }
        }
        let value = match method {
            "stat" => serde_json::to_value(self.backend.stat(path).await?),
            "readDir" => serde_json::to_value(self.backend.read_dir(path).await?),
            "readFile" => serde_json::to_value(self.backend.read_file(path, None).await?.data),
            "readFileSnapshot" => serde_json::to_value(self.backend.read_file(path, None).await?),
            "mkdir" => {
                self.backend
                    .mkdir(
                        path,
                        params["options"]["recursive"].as_bool().unwrap_or(false),
                    )
                    .await?;
                Ok(serde_json::Value::Null)
            }
            "writeFile" => {
                self.before_replace(path)?;
                let data: Vec<u8> = serde_json::from_value(params["data"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), path))?;
                let revision = self
                    .backend
                    .write_file(
                        path,
                        &data,
                        params["options"]["mode"].as_str().unwrap_or("create"),
                        params["options"]["expectedRevision"].as_str(),
                    )
                    .await?;
                self.refresh_path(path).await?;
                Ok(serde_json::Value::String(revision))
            }
            "rename" => {
                self.rename(
                    path,
                    params["to"].as_str().ok_or_else(|| {
                        EditorError::new("InvalidPath", "Missing destination", path)
                    })?,
                )
                .await?;
                Ok(serde_json::Value::Null)
            }
            "remove" => {
                self.remove(
                    path,
                    params["options"]["recursive"].as_bool().unwrap_or(false),
                )
                .await?;
                Ok(serde_json::Value::Null)
            }
            _ => {
                return Err(EditorError::new(
                    "Unsupported",
                    "Unknown file operation",
                    path,
                ));
            }
        };
        value.map_err(|e| EditorError::new("IO", e.to_string(), path))
    }
    /// Same service commands over Worker, IPC, or a headless reference caller.
    pub async fn execute_service(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> EditorResult<serde_json::Value> {
        use serde_json::{Value, to_value};
        let id = params["id"].as_str().unwrap_or("");
        let value = match method {
            "open" => {
                let path = params["path"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidPath", "Missing file path", ""))?;
                let id = self.open_file(path).await?;
                to_value(self.read(&id)?)
            }
            "read" => to_value(self.read(id)?),
            "resident" => to_value(
                self.records
                    .keys()
                    .map(|id| self.read(id))
                    .collect::<EditorResult<Vec<_>>>()?,
            ),
            "edit" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Edit {
                    id: String,
                    version: Version,
                    edits: Vec<TextEdit>,
                    context: SelectionContext,
                    user_event: String,
                }
                let p: Edit = serde_json::from_value(params)
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                to_value(
                    self.edit(&p.id, p.version, p.edits, p.context, p.user_event)
                        .await?,
                )
            }
            "undo" => {
                let context = serde_json::from_value(params["context"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                to_value(
                    self.undo_view(id, context, params["redo"].as_bool().unwrap_or(false))
                        .await?,
                )
            }
            "save" => {
                let _ = self.save(id, None).await;
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
            "flush" | "close" => {
                self.flush().await?;
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
