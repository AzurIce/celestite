//! Executable specification, not a production filesystem backend.
//! A single owner serializes observations, imports and writes. Every observation
//! commits its CRDT history and disk cursor together in one redb transaction.
use loro::{ExportMode, Frontiers, LoroDoc};
use redb::{Database, ReadableDatabase, TableDefinition};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use thiserror::Error;

const CHECKPOINT: TableDefinition<&str, &[u8]> = TableDefinition::new("checkpoint");
const MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum Error {
    #[error("injected crash at {0:?}")]
    Crash(Fault),
    #[error("write outcome is uncertain; automatic reconciliation is stopped")]
    UncertainWrite,
    #[error("disk changed before write")]
    DiskChanged,
    #[error("invalid or oversized text")]
    InvalidText,
    #[error("operation needs write recovery first")]
    PendingWrite,
    #[error("{0}")]
    Internal(String),
}
pub type Result<T> = std::result::Result<T, Error>;
fn internal(e: impl std::fmt::Display) -> Error {
    Error::Internal(e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    None,
    BeforeObservationCommit,
    AfterObservationCommit,
    BeforeIntentCommit,
    AfterIntentCommit,
    BeforeStartedCommit,
    AfterStartedCommit,
    AfterDiskWrite,
    BeforeReceiptCommit,
    AfterReceiptCommit,
}
fn crash(actual: Fault, at: Fault) -> Result<()> {
    if actual == at {
        Err(Error::Crash(at))
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Format {
    pub bom: bool,
    pub ending: String,
}
fn decode(bytes: &[u8]) -> Result<(String, Format)> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::InvalidText);
    }
    let s = std::str::from_utf8(bytes).map_err(|_| Error::InvalidText)?;
    let bom = s.starts_with('\u{feff}');
    let s = s.strip_prefix('\u{feff}').unwrap_or(s);
    if s.contains('\0') {
        return Err(Error::InvalidText);
    }
    let ending = s
        .find(['\r', '\n'])
        .map(|p| {
            if s[p..].starts_with("\r\n") {
                "\r\n"
            } else if s[p..].starts_with('\r') {
                "\r"
            } else {
                "\n"
            }
        })
        .unwrap_or("\n");
    Ok((
        s.replace("\r\n", "\n").replace('\r', "\n"),
        Format {
            bom,
            ending: ending.into(),
        },
    ))
}
fn encode(text: &str, format: &Format) -> Vec<u8> {
    format!(
        "{}{}",
        if format.bom { "\u{feff}" } else { "" },
        text.replace('\n', &format.ending)
    )
    .into_bytes()
}
fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn snapshot(doc: &LoroDoc) -> Result<Vec<u8>> {
    doc.export(ExportMode::Snapshot).map_err(internal)
}
fn restore(bytes: &[u8]) -> Result<LoroDoc> {
    LoroDoc::from_snapshot(bytes).map_err(internal)
}
fn frontiers(bytes: &[u8]) -> Result<Frontiers> {
    Frontiers::decode(bytes).map_err(internal)
}
fn text(doc: &LoroDoc) -> String {
    doc.get_text("source").to_string()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DiskCursor {
    pub bytes: Vec<u8>,
    pub hash: String,
    pub text: String,
    pub frontiers: Vec<u8>,
    pub format: Format,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum WritePhase {
    Prepared,
    Started,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct WriteIntent {
    pub id: u64,
    pub phase: WritePhase,
    pub expected_hash: String,
    pub target: DiskCursor,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub sequence: u64,
    pub core_snapshot: Vec<u8>,
    pub cursor: DiskCursor,
    pub next_writer: u64,
    pub imported_observations: u64,
    pub pending_packets: Vec<Vec<u8>>,
    pub intent: Option<WriteIntent>,
}
fn reconstruct(state: &Checkpoint) -> Result<LoroDoc> {
    let doc = restore(&state.core_snapshot)?;
    for packet in &state.pending_packets {
        doc.import(packet).map_err(internal)?;
    }
    Ok(doc)
}
#[derive(Clone)]
pub struct Observation {
    pub sequence: u64,
    pub bytes: Vec<u8>,
    pub packet: Option<Vec<u8>>,
}

pub struct Bridge {
    db: Database,
    state: Checkpoint,
    core: LoroDoc,
}
impl Bridge {
    pub fn create(database: &Path, initial: &[u8]) -> Result<Self> {
        let (text, format) = decode(initial)?;
        let core = LoroDoc::new();
        core.set_peer_id(1).map_err(internal)?;
        core.get_text("source").insert(0, &text).map_err(internal)?;
        core.commit();
        core.set_peer_id(2).map_err(internal)?;
        let state = Checkpoint {
            sequence: 0,
            core_snapshot: snapshot(&core)?,
            cursor: DiskCursor {
                bytes: initial.into(),
                hash: hash(initial),
                text,
                frontiers: core.state_frontiers().encode(),
                format,
            },
            next_writer: 100,
            imported_observations: 0,
            pending_packets: vec![],
            intent: None,
        };
        let mut bridge = Self {
            db: Database::create(database).map_err(internal)?,
            state,
            core,
        };
        bridge.commit(bridge.state.clone())?;
        Ok(bridge)
    }
    pub fn reopen(database: &Path) -> Result<Self> {
        let db = Database::open(database).map_err(internal)?;
        let state: Checkpoint = {
            let tx = db.begin_read().map_err(internal)?;
            let table = tx.open_table(CHECKPOINT).map_err(internal)?;
            let bytes = table
                .get("document")
                .map_err(internal)?
                .ok_or_else(|| internal("missing checkpoint"))?;
            serde_json::from_slice(bytes.value()).map_err(internal)?
        };
        let core = reconstruct(&state)?;
        core.set_peer_id(2).map_err(internal)?;
        let bridge = Self { db, state, core };
        bridge.validate()?;
        Ok(bridge)
    }
    fn commit(&mut self, mut candidate: Checkpoint) -> Result<()> {
        let trial = reconstruct(&candidate)?;
        let mut pending = vec![];
        for packet in &candidate.pending_packets {
            let status = trial.import(packet).map_err(internal)?;
            if status.pending.is_some_and(|p| !p.is_empty()) {
                pending.push(packet.clone());
            }
        }
        decode(text(&trial).as_bytes())?;
        candidate.pending_packets = pending;
        candidate.core_snapshot = snapshot(&trial)?;
        let bytes = serde_json::to_vec(&candidate).map_err(internal)?;
        let tx = self.db.begin_write().map_err(internal)?;
        {
            let mut table = tx.open_table(CHECKPOINT).map_err(internal)?;
            table
                .insert("document", bytes.as_slice())
                .map_err(internal)?;
        }
        tx.commit().map_err(internal)?;
        // Publishing follows durability. Failpoint tests can drop this instance
        // after commit to simulate losing its response.
        self.core = reconstruct(&candidate)?;
        self.core.set_peer_id(2).map_err(internal)?;
        self.state = candidate;
        self.validate()
    }
    pub fn validate(&self) -> Result<()> {
        let disk_branch = self
            .core
            .fork_at(&frontiers(&self.state.cursor.frontiers)?)
            .map_err(internal)?;
        if text(&disk_branch) != self.state.cursor.text
            || hash(&self.state.cursor.bytes) != self.state.cursor.hash
            || decode(&self.state.cursor.bytes)?.0 != self.state.cursor.text
        {
            return Err(internal("disk cursor invariant failed"));
        }
        if let Some(intent) = &self.state.intent {
            let branch = self
                .core
                .fork_at(&frontiers(&intent.target.frontiers)?)
                .map_err(internal)?;
            if text(&branch) != intent.target.text
                || encode(&intent.target.text, &intent.target.format) != intent.target.bytes
                || hash(&intent.target.bytes) != intent.target.hash
            {
                return Err(internal("write intent invariant failed"));
            }
        }
        Ok(())
    }
    pub fn state(&self) -> &Checkpoint {
        &self.state
    }
    pub fn text(&self) -> String {
        text(&self.core)
    }
    pub fn core(&self) -> &LoroDoc {
        &self.core
    }
    pub fn observe(&mut self, bytes: &[u8], fault: Fault) -> Result<Option<Observation>> {
        if self.state.intent.is_some() {
            return Err(Error::PendingWrite);
        }
        if hash(bytes) == self.state.cursor.hash {
            return Ok(None);
        }
        let (new_text, format) = decode(bytes)?;
        let mut candidate = self.state.clone();
        let branch = self
            .core
            .fork_at(&frontiers(&candidate.cursor.frontiers)?)
            .map_err(internal)?;
        // Fixed writer values are ONLY for reproducible tests under exclusive
        // ownership. Production should use fresh random writer IDs per branch.
        branch
            .set_peer_id(candidate.next_writer)
            .map_err(internal)?;
        let before = branch.oplog_vv();
        let packet = if new_text == candidate.cursor.text {
            None
        } else {
            // Myers scalar diff on an isolated branch. A timeout/error cannot
            // publish a partially updated live document.
            branch
                .get_text("source")
                .update(&new_text, Default::default())
                .map_err(internal)?;
            branch.commit();
            candidate.next_writer += 1;
            Some(
                branch
                    .export(ExportMode::updates(&before))
                    .map_err(internal)?,
            )
        };
        assert_eq!(text(&branch), new_text);
        let trial = reconstruct(&candidate)?;
        if let Some(packet) = &packet {
            trial.import(packet).map_err(internal)?;
        }
        candidate.core_snapshot = snapshot(&trial)?;
        candidate.cursor = DiskCursor {
            bytes: bytes.into(),
            hash: hash(bytes),
            text: new_text,
            frontiers: branch.state_frontiers().encode(),
            format,
        };
        candidate.sequence += 1;
        candidate.imported_observations += 1;
        let receipt = Observation {
            sequence: candidate.sequence,
            bytes: bytes.into(),
            packet,
        };
        crash(fault, Fault::BeforeObservationCommit)?;
        self.commit(candidate)?;
        crash(fault, Fault::AfterObservationCommit)?;
        Ok(Some(receipt))
    }
    pub fn import(&mut self, packet: &[u8]) -> Result<()> {
        if self.state.intent.is_some() {
            return Err(Error::PendingWrite);
        }
        let trial = reconstruct(&self.state)?;
        let before = trial.oplog_vv();
        let status = trial.import(packet).map_err(internal)?;
        decode(text(&trial).as_bytes())?;
        let mut candidate = self.state.clone();
        if status.pending.is_some_and(|p| !p.is_empty())
            && !candidate.pending_packets.iter().any(|p| p == packet)
        {
            candidate.pending_packets.push(packet.into());
        }
        if trial.oplog_vv() == before && candidate.pending_packets == self.state.pending_packets {
            return Ok(());
        }
        candidate.core_snapshot = snapshot(&trial)?;
        candidate.sequence += 1;
        self.commit(candidate)
    }
    pub fn edit(&mut self, target: &str) -> Result<()> {
        if self.state.intent.is_some() {
            return Err(Error::PendingWrite);
        }
        decode(target.as_bytes())?;
        let trial = reconstruct(&self.state)?;
        trial.set_peer_id(2).map_err(internal)?;
        trial
            .get_text("source")
            .update(target, Default::default())
            .map_err(internal)?;
        trial.commit();
        let mut candidate = self.state.clone();
        candidate.core_snapshot = snapshot(&trial)?;
        candidate.sequence += 1;
        self.commit(candidate)
    }
    /// Stage a target against the current disk cursor. The actual filesystem
    /// adapter must recheck its hash. This model does not promise atomic CAS.
    pub fn prepare_write(&mut self, fault: Fault) -> Result<bool> {
        if self.state.intent.is_some() {
            return Err(Error::PendingWrite);
        }
        if self.text() == self.state.cursor.text {
            return Ok(false);
        }
        let mut candidate = self.state.clone();
        let target_text = self.text();
        let bytes = encode(&target_text, &candidate.cursor.format);
        candidate.intent = Some(WriteIntent {
            id: candidate.sequence + 1,
            phase: WritePhase::Prepared,
            expected_hash: candidate.cursor.hash.clone(),
            target: DiskCursor {
                hash: hash(&bytes),
                bytes,
                text: target_text,
                frontiers: self.core.state_frontiers().encode(),
                format: candidate.cursor.format.clone(),
            },
        });
        candidate.sequence += 1;
        crash(fault, Fault::BeforeIntentCommit)?;
        self.commit(candidate)?;
        crash(fault, Fault::AfterIntentCommit)?;
        Ok(true)
    }
    pub fn start_write(&mut self, disk: &[u8], fault: Fault) -> Result<()> {
        let intent = self.state.intent.as_ref().ok_or(Error::PendingWrite)?;
        if intent.phase != WritePhase::Prepared {
            return Err(Error::UncertainWrite);
        }
        if hash(disk) != intent.expected_hash {
            self.cancel_prepared()?;
            return Err(Error::DiskChanged);
        }
        let mut candidate = self.state.clone();
        candidate.intent.as_mut().unwrap().phase = WritePhase::Started;
        candidate.sequence += 1;
        crash(fault, Fault::BeforeStartedCommit)?;
        self.commit(candidate)?;
        crash(fault, Fault::AfterStartedCommit)
    }
    fn cancel_prepared(&mut self) -> Result<()> {
        let mut candidate = self.state.clone();
        if candidate
            .intent
            .as_ref()
            .is_some_and(|i| i.phase != WritePhase::Prepared)
        {
            return Err(Error::UncertainWrite);
        }
        candidate.intent = None;
        candidate.sequence += 1;
        self.commit(candidate)
    }
    /// Call ONLY when this process knows the write completed, or recovery sees
    /// exactly its target bytes. Never infer the disk version from core latest.
    pub fn complete_write(&mut self, fault: Fault) -> Result<()> {
        let mut candidate = self.state.clone();
        let intent = candidate.intent.take().ok_or(Error::PendingWrite)?;
        if intent.phase != WritePhase::Started {
            return Err(Error::PendingWrite);
        }
        candidate.cursor = intent.target;
        candidate.sequence += 1;
        crash(fault, Fault::BeforeReceiptCommit)?;
        self.commit(candidate)?;
        crash(fault, Fault::AfterReceiptCommit)
    }
    /// A Prepared intent proves IO has not started. A Started intent with a
    /// different disk hash is ambiguous, INCLUDING an unchanged old hash (ABA).
    pub fn recover(&mut self, disk: &[u8]) -> Result<()> {
        match self.state.intent.as_ref() {
            None => Ok(()),
            Some(intent) if intent.phase == WritePhase::Prepared => self.cancel_prepared(),
            Some(intent) if hash(disk) == intent.target.hash => self.complete_write(Fault::None),
            Some(_) => Err(Error::UncertainWrite),
        }
    }
    /// Explicit save, appropriate only for a quiescent/cooperating filesystem.
    /// The spike keeps target staging simple and exercises races separately.
    pub fn save_file(&mut self, path: &Path, fault: Fault) -> Result<bool> {
        let disk = fs::read(path).map_err(internal)?;
        self.observe(&disk, Fault::None)?;
        if !self.prepare_write(fault)? {
            return Ok(false);
        }
        self.start_write(&fs::read(path).map_err(internal)?, fault)?;
        let target = self.state.intent.as_ref().unwrap().target.bytes.clone();
        let staging = path.with_extension("spike-stage");
        fs::write(&staging, &target).map_err(internal)?;
        fs::File::open(&staging)
            .map_err(internal)?
            .sync_all()
            .map_err(internal)?;
        fs::rename(staging, path).map_err(internal)?;
        fs::File::open(path.parent().unwrap())
            .map_err(internal)?
            .sync_all()
            .map_err(internal)?;
        crash(fault, Fault::AfterDiskWrite)?;
        self.complete_write(fault)?;
        Ok(true)
    }
}
