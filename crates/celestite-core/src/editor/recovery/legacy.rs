//! One-time text extraction from retired stores. There is no CRDT writer here.
use super::{Baseline, Draft, WriteRecovery, read_json};
use crate::editor::decode;
use crate::editor::state::{DirectoryIntent, DirectoryOperation, WritePhase};
use crate::error::{EditorError, EditorResult, ErrorCode};
use crate::fs::validate_path;
use crate::fs::{EntryKind, FileSystem};
use crate::text::LineEnding;
use celestite_buffer::{
    Buffer,
    types::{DocumentIdentity, HistoryPacket, HistoryPacketKind, Version},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

#[derive(Deserialize)]
struct Cursor {
    bytes: Vec<u8>,
    version: Version,
}
#[derive(Deserialize)]
struct Pending {
    text: String,
    #[serde(default)]
    phase: String,
}
#[derive(Deserialize)]
struct Header {
    id: String,
    path: String,
    seed: HistoryPacket,
    sequence: u64,
    applied: Version,
    saved_text: String,
    disk_revision: String,
    saved_version: Option<Version>,
    pending_write: Option<Pending>,
    disk_cursor: Option<Cursor>,
    deleted: bool,
    bom: bool,
    line_ending: LineEnding,
}
#[derive(Deserialize)]
struct Journal {
    packet: HistoryPacket,
    applied: Version,
}
#[derive(Deserialize)]
struct NativeHead {
    seed: String,
    baseline: String,
    id: String,
    path: String,
    sequence: u64,
    applied: Version,
    disk_revision: String,
    saved_version: Option<Version>,
    pending_write: Option<Pending>,
    deleted: bool,
    bom: bool,
    line_ending: LineEnding,
}
#[derive(Deserialize)]
struct NativeBaseline {
    saved_text: String,
    disk_cursor: Option<Cursor>,
}

fn error(path: &str, message: &str) -> EditorError {
    EditorError::new(ErrorCode::Io, message, path)
}

async fn required<S: FileSystem, T: DeserializeOwned>(fs: &S, path: &str) -> EditorResult<T> {
    read_json(fs, path).await?.ok_or_else(|| {
        error(
            path,
            "Missing legacy recovery data; original files retained",
        )
    })
}
async fn blob<S: FileSystem, T: DeserializeOwned>(fs: &S, root: &str, id: &str) -> EditorResult<T> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(error(root, "Invalid legacy object reference"));
    }
    let path = format!("{root}/objects/{id}.json");
    let data = fs
        .read_file(&path, Some(super::MAX_RECOVERY_BYTES))
        .await?
        .data;
    #[cfg(all(feature = "native", not(target_arch = "wasm32")))]
    if blake3::hash(&data).to_hex().as_str() != id {
        return Err(error(&path, "Legacy object checksum mismatch"));
    }
    serde_json::from_slice(&data).map_err(|e| EditorError::new(ErrorCode::Io, e.to_string(), &path))
}

fn text_draft(header: Header, buffer: Buffer) -> EditorResult<Draft> {
    validate_path(&header.path)?;
    if header.id != header.seed.identity.document_id || buffer.version() != header.applied {
        return Err(error(&header.path, "Legacy CRDT identity/version mismatch"));
    }
    let baseline = if let Some(cursor) = header.disk_cursor {
        if decode(&cursor.bytes, &header.path)?.text != header.saved_text
            || buffer.historical_text(&cursor.version)? != header.saved_text
        {
            return Err(error(&header.path, "Invalid legacy disk baseline"));
        }
        cursor.bytes
    } else {
        if let Some(version) = &header.saved_version
            && buffer.historical_text(version)? != header.saved_text
        {
            return Err(error(&header.path, "Invalid legacy saved version"));
        }
        format!(
            "{}{}",
            if header.bom { "\u{feff}" } else { "" },
            header.line_ending.restore(&header.saved_text)
        )
        .into_bytes()
    };
    Ok(Draft {
        schema: 1,
        path: header.path,
        text: buffer.snapshot().text.to_string(),
        baseline: Baseline {
            bytes: baseline,
            revision: header.disk_revision,
        },
        deleted: header.deleted,
        pending_write: header.pending_write.map(|p| WriteRecovery {
            text: p.text,
            phase: if p.phase == "prepared" {
                WritePhase::Prepared
            } else {
                WritePhase::Started
            },
        }),
    })
}

pub(super) async fn drafts<S: FileSystem>(fs: &S) -> EditorResult<Vec<Draft>> {
    if let Some(catalog) = read_json::<_, Catalog>(fs, "catalog.json").await? {
        return browser(fs, catalog).await;
    }
    let entries = match fs.read_dir("documents").await {
        Ok(entries) => entries,
        Err(e) if e.code == ErrorCode::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut drafts = Vec::new();
    for entry in entries {
        if entry.kind != EntryKind::Directory {
            continue;
        }
        let Some(head) =
            read_json::<_, NativeHead>(fs, &format!("{}/head.json", entry.path)).await?
        else {
            continue;
        };
        let seed: HistoryPacket = blob(fs, &entry.path, &head.seed).await?;
        let baseline: NativeBaseline = blob(fs, &entry.path, &head.baseline).await?;
        let header = Header {
            id: head.id,
            path: head.path,
            seed,
            sequence: head.sequence,
            applied: head.applied,
            saved_text: baseline.saved_text,
            disk_revision: head.disk_revision,
            saved_version: head.saved_version,
            pending_write: head.pending_write,
            disk_cursor: baseline.disk_cursor,
            deleted: head.deleted,
            bom: head.bom,
            line_ending: head.line_ending,
        };
        let mut buffer = Buffer::from_snapshot(&header.seed)?;
        for sequence in 1..=header.sequence {
            let entry: Journal =
                required(fs, &format!("{}/journal/{sequence}.json", entry.path)).await?;
            let _ = buffer.import(entry.packet)?;
            if buffer.version() != entry.applied {
                return Err(error(&header.path, "Invalid legacy journal"));
            }
        }
        drafts.push(text_draft(header, buffer)?);
    }
    Ok(drafts)
}

#[derive(Deserialize)]
struct Catalog {
    schema: u32,
    entries: Vec<CatalogEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    id: String,
    history_id: String,
    path: String,
    deleted: bool,
}
#[derive(Deserialize)]
struct BrowserHead {
    sequence: u64,
    version: Version,
    header: Option<Header>,
}
#[derive(Deserialize)]
struct UpdateMeta {
    applied: Version,
    kind: HistoryPacketKind,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    saved_content: String,
    disk_revision: String,
    bom: bool,
    line_ending: LineEnding,
}

async fn browser<S: FileSystem>(fs: &S, catalog: Catalog) -> EditorResult<Vec<Draft>> {
    if catalog.schema != 1 {
        return Err(error("catalog.json", "Unsupported legacy catalog"));
    }
    let mut drafts = Vec::new();
    for entry in catalog.entries {
        validate_path(&entry.path)?;
        if entry.id.len() != 36 || !entry.id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err(error(&entry.path, "Invalid legacy document ID"));
        }
        let dir = format!("documents/{}", entry.id);
        let head: BrowserHead = required(fs, &format!("{dir}/head.json")).await?;
        let seed = HistoryPacket {
            identity: DocumentIdentity {
                document_id: entry.id.clone(),
                history_id: entry.history_id,
            },
            kind: HistoryPacketKind::Snapshot,
            data: fs
                .read_file(&format!("{dir}/seed.bin"), Some(super::MAX_RECOVERY_BYTES))
                .await?
                .data
                .into(),
        };
        let mut buffer = Buffer::from_snapshot(&seed)?;
        for sequence in 1..=head.sequence {
            let meta: Option<UpdateMeta> =
                read_json(fs, &format!("{dir}/updates/{sequence}.meta.json")).await?;
            let packet = HistoryPacket {
                identity: seed.identity.clone(),
                kind: meta.as_ref().map_or(HistoryPacketKind::Updates, |m| m.kind),
                data: fs
                    .read_file(
                        &format!("{dir}/updates/{sequence}.bin"),
                        Some(super::MAX_RECOVERY_BYTES),
                    )
                    .await?
                    .data
                    .into(),
            };
            let _ = buffer.import(packet)?;
            if meta.is_some_and(|m| m.applied != buffer.version()) {
                return Err(error(&entry.path, "Invalid legacy update"));
            }
        }
        let header = if let Some(header) = head.header {
            if header.seed.identity != seed.identity
                || header.seed.data != seed.data
                || header.sequence != head.sequence
            {
                return Err(error(&entry.path, "Legacy browser seed mismatch"));
            }
            header
        } else {
            let receipt: Receipt = required(fs, &format!("{dir}/projection.json")).await?;
            let pending: Option<Receipt> =
                read_json(fs, &format!("{dir}/save-intent.json")).await?;
            Header {
                id: entry.id,
                path: entry.path,
                seed,
                sequence: head.sequence,
                applied: head.version.clone(),
                saved_text: receipt.saved_content,
                disk_revision: receipt.disk_revision,
                saved_version: None,
                pending_write: pending.map(|p| Pending {
                    text: p.saved_content,
                    phase: "started".into(),
                }),
                disk_cursor: None,
                deleted: entry.deleted,
                bom: receipt.bom,
                line_ending: receipt.line_ending,
            }
        };
        if header.applied != head.version {
            return Err(error(&header.path, "Legacy browser head mismatch"));
        }
        drafts.push(text_draft(header, buffer)?);
    }
    Ok(drafts)
}

pub(super) async fn directory_intent<S: FileSystem>(
    fs: &S,
) -> EditorResult<Option<DirectoryIntent>> {
    if let Some(value) = read_json::<_, Value>(fs, "directory-intent.json")
        .await?
        .filter(|value| !value.is_null())
    {
        if value.get("paths").is_some() {
            return serde_json::from_value(value)
                .map(Some)
                .map_err(|e| error("directory-intent.json", &e.to_string()));
        }
        let operation = serde_json::from_value::<DirectoryOperation>(value["operation"].clone())
            .map_err(|e| error("directory-intent.json", &e.to_string()))?;
        let entries: Vec<(String, String)> = serde_json::from_value(value["entries"].clone())
            .map_err(|e| error("directory-intent.json", &e.to_string()))?;
        return Ok(Some(DirectoryIntent {
            operation,
            from: value["from"]
                .as_str()
                .ok_or_else(|| error("directory-intent.json", "Missing source"))?
                .into(),
            to: value["to"].as_str().map(str::to_owned),
            paths: entries.into_iter().map(|(_, path)| path).collect(),
        }));
    }
    for (file, operation, field) in [
        ("rename-intent.json", DirectoryOperation::Rename, "entries"),
        ("remove-intent.json", DirectoryOperation::Remove, "paths"),
    ] {
        if let Some(value) = read_json::<_, Value>(fs, file)
            .await?
            .filter(|value| !value.is_null())
        {
            let paths = value[field]
                .as_array()
                .ok_or_else(|| error(file, "Missing recovery paths"))?
                .iter()
                .map(|entry| {
                    entry["path"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| error(file, "Invalid recovery path"))
                })
                .collect::<EditorResult<Vec<_>>>()?;
            return Ok(Some(DirectoryIntent {
                operation,
                from: value["from"].as_str().unwrap_or("").into(),
                to: value["to"].as_str().map(str::to_owned),
                paths,
            }));
        }
    }
    Ok(None)
}
