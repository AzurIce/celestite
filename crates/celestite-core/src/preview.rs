//! Derived document previews. Scheduling policy lives here; platforms execute
//! immutable tasks separately from editing and persistence.
use crate::{EditorError, EditorResult, TextSnapshot, Version};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const PREVIEW_DEBOUNCE_MS: u64 = 120;
pub const PREVIEW_MAX_WAIT_MS: u64 = 500;
pub const MAX_PREVIEW_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PREVIEW_CACHE_BYTES: usize = 64 * 1024 * 1024;

pub fn supports_preview(path: &str) -> bool {
    preview_extension(path).is_some()
}

fn preview_extension(path: &str) -> Option<String> {
    let extension = std::path::Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    matches!(extension.as_str(), "not" | "md" | "markdown").then_some(extension)
}

/// Only core issues tickets. The executor echoes task_id, never asserts which
/// document version its output belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTicket {
    pub task_id: String,
    pub session_id: String,
    pub document_id: String,
    pub version: Version,
    pub path: String,
    pub render_generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTask {
    pub ticket: PreviewTicket,
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewDiagnosticOrigin {
    Analysis,
    Render,
}

/// Half-open UTF-16 offsets in the task's LF source, not the UI input projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDiagnostic {
    pub from: usize,
    pub to: usize,
    pub origin: PreviewDiagnosticOrigin,
    pub phase: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOutput {
    pub html: String,
    pub diagnostics: Vec<PreviewDiagnostic>,
    #[serde(default)]
    pub source_map: Vec<PreviewSourceMapping>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewMappingKind {
    Block,
    Inline,
    Container,
}

/// Output element ID scoped to the result ticket, with a half-open UTF-16 range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSourceMapping {
    pub node_id: usize,
    pub from: usize,
    pub to: usize,
    pub kind: PreviewMappingKind,
}
impl PreviewOutput {
    fn bytes(&self) -> usize {
        self.diagnostics.iter().fold(
            self.html.len().saturating_add(
                self.source_map
                    .len()
                    .saturating_mul(std::mem::size_of::<PreviewSourceMapping>()),
            ),
            |size, diagnostic| {
                size.saturating_add(std::mem::size_of::<PreviewDiagnostic>())
                    .saturating_add(diagnostic.message.len())
                    .saturating_add(diagnostic.phase.len())
            },
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreviewOutcome {
    Success { output: PreviewOutput },
    Failure { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCompletion {
    pub task_id: String,
    pub outcome: PreviewOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub ticket: PreviewTicket,
    pub output: PreviewOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewStatus {
    Unsupported,
    Pending,
    Computing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    pub target: PreviewTicket,
    pub status: PreviewStatus,
    pub result: Option<PreviewResult>,
    pub error: Option<String>,
    /// Deadline on the Backend clock. None while the current target is running
    /// or awaiting retry. An older running task can still delay dispatch.
    pub due_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSubscription {
    pub subscription_id: String,
    pub state: PreviewState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEvent {
    pub sequence: u64,
    pub document_id: String,
    /// None closes this preview session; it does not close document history.
    pub state: Option<PreviewState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreviewLink {
    Fragment {
        fragment: String,
    },
    Document {
        path: String,
        fragment: Option<String>,
    },
    External {
        url: String,
    },
}

/// Interpret renderer URLs within a Vault, independently of browser location.
pub fn resolve_preview_target(path: &str, target: &str) -> EditorResult<PreviewLink> {
    let invalid = || {
        EditorError::new(
            "InvalidPath",
            "Invalid preview link or path outside Vault",
            path,
        )
    };
    let target: String = target
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let target = target.trim_matches(|c: char| c <= '\u{20}');
    let prefix = target.split(['/', '\\', '?', '#']).next().unwrap_or("");
    if let Some((scheme, _)) = prefix.split_once(':') {
        if !["https", "http", "mailto", "tel", "ftp"]
            .iter()
            .any(|s| scheme.eq_ignore_ascii_case(s))
        {
            return Err(invalid());
        }
        return Ok(PreviewLink::External { url: target.into() });
    }
    if target.starts_with("//") {
        return Ok(PreviewLink::External { url: target.into() });
    }
    fn decode(value: &str) -> Option<String> {
        let mut bytes = Vec::new();
        let mut input = value.bytes();
        while let Some(byte) = input.next() {
            bytes.push(if byte == b'%' {
                let hex = [input.next()?, input.next()?];
                u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?
            } else {
                byte
            });
        }
        String::from_utf8(bytes).ok()
    }
    let (target_path, fragment) = target
        .split_once('#')
        .map_or((target, None), |(p, f)| (p, Some(f)));
    let fragment = fragment
        .map(|f| decode(f).ok_or_else(invalid))
        .transpose()?;
    if target_path.is_empty() {
        return Ok(PreviewLink::Fragment {
            fragment: fragment.unwrap_or_default(),
        });
    }
    if target_path.contains('?') {
        return Err(invalid());
    }
    let decoded = decode(target_path).ok_or_else(invalid)?;
    if decoded.contains(['\\', '\0']) {
        return Err(invalid());
    }
    let parent = path.rsplit_once('/').map_or("", |(p, _)| p);
    let mut segments: Vec<_> = if decoded.starts_with('/') {
        vec![]
    } else {
        parent.split('/').filter(|s| !s.is_empty()).collect()
    };
    for segment in decoded.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err(invalid());
                }
            }
            segment => segments.push(segment),
        }
    }
    let path = segments.join("/");
    crate::validate_editor_path(&path)?;
    if path.is_empty() {
        return Err(invalid());
    }
    Ok(PreviewLink::Document { path, fragment })
}

/// Pure synchronous computation. Run in a dedicated Worker / CPU task, never
/// synchronously in an edit or save command. No IO or CRDT writes occur here.
#[cfg(feature = "preview")]
pub fn compute_preview(task: &PreviewTask) -> PreviewCompletion {
    let computed = (|| -> EditorResult<PreviewOutput> {
        if task.source.len() > crate::MAX_TEXT_BYTES || task.source.contains('\r') {
            return Err(EditorError::new(
                "InvalidPreview",
                "Preview requires bounded LF source",
                &task.ticket.path,
            ));
        }
        let extension = preview_extension(&task.ticket.path).ok_or_else(|| {
            EditorError::new(
                "Unsupported",
                "Unsupported preview format",
                &task.ticket.path,
            )
        })?;
        // Frontend selection is case-sensitive; the logical path remains in
        // the ticket for resource resolution, while dispatch uses a canonical ext.
        let analysis = notist::Notist::default()
            .analyze(format!("preview.{extension}"), &task.source)
            .map_err(|error| {
                EditorError::new("Unsupported", error.to_string(), &task.ticket.path)
            })?;
        let rendered = notist_html::Renderer::new()
            .with_source_map()
            .render_with_diagnostics(analysis.root());
        let raw_diagnostics: Vec<_> = analysis
            .diagnostics()
            .iter()
            .map(|diagnostic| (PreviewDiagnosticOrigin::Analysis, diagnostic))
            .chain(
                rendered
                    .diagnostics
                    .iter()
                    .map(|diagnostic| (PreviewDiagnosticOrigin::Render, diagnostic)),
            )
            .collect();
        // Walk source once for all requested boundaries. Counting each prefix
        // separately would become quadratic on a document with many errors.
        let mut offsets: Vec<_> = raw_diagnostics
            .iter()
            .flat_map(|(_, diagnostic)| {
                [
                    usize::from(diagnostic.span.start()),
                    usize::from(diagnostic.span.end()),
                ]
            })
            .chain(
                rendered
                    .source_map
                    .iter()
                    .flat_map(|entry| [entry.range.start, entry.range.end]),
            )
            .collect();
        offsets.sort_unstable();
        offsets.dedup();
        let mut units = Vec::with_capacity(offsets.len());
        let mut chars = task.source.chars();
        let (mut byte, mut utf16) = (0, 0);
        for &offset in &offsets {
            while byte < offset {
                let Some(character) = chars.next() else {
                    return Err(EditorError::new(
                        "InvalidPreview",
                        "Preview mapping exceeds source",
                        &task.ticket.path,
                    ));
                };
                byte += character.len_utf8();
                utf16 += character.len_utf16();
            }
            if byte != offset {
                return Err(EditorError::new(
                    "InvalidPreview",
                    "Preview mapping splits a Unicode scalar",
                    &task.ticket.path,
                ));
            }
            units.push(utf16);
        }
        let diagnostics = raw_diagnostics
            .into_iter()
            .map(|(origin, diagnostic)| {
                let from = usize::from(diagnostic.span.start());
                let to = usize::from(diagnostic.span.end());
                PreviewDiagnostic {
                    from: units[offsets.binary_search(&from).unwrap()],
                    to: units[offsets.binary_search(&to).unwrap()],
                    origin,
                    phase: diagnostic.phase.to_string(),
                    message: diagnostic.message.clone(),
                }
            })
            .collect();
        let output = PreviewOutput {
            html: rendered.html,
            diagnostics,
            source_map: rendered
                .source_map
                .into_iter()
                .map(|entry| PreviewSourceMapping {
                    node_id: entry.node_id,
                    from: units[offsets.binary_search(&entry.range.start).unwrap()],
                    to: units[offsets.binary_search(&entry.range.end).unwrap()],
                    kind: match entry.kind {
                        notist_html::SourceMappingKind::Block => PreviewMappingKind::Block,
                        notist_html::SourceMappingKind::Inline => PreviewMappingKind::Inline,
                        notist_html::SourceMappingKind::Container => PreviewMappingKind::Container,
                    },
                })
                .collect(),
        };
        if output.bytes() > MAX_PREVIEW_OUTPUT_BYTES {
            return Err(EditorError::new(
                "PreviewLimit",
                "预览内容超过容量，请缩小文档。",
                &task.ticket.path,
            ));
        }
        Ok(output)
    })();
    PreviewCompletion {
        task_id: task.ticket.task_id.clone(),
        outcome: match computed {
            Ok(output) => PreviewOutcome::Success { output },
            Err(error) => PreviewOutcome::Failure {
                message: error.message,
            },
        },
    }
}

struct Session {
    subscribers: BTreeMap<String, String>,
    state: PreviewState,
    running: Option<PreviewTicket>,
    dirty_since: Option<u64>,
}

pub(crate) struct PreviewSessions {
    scope: String,
    next_id: u64,
    sequence: u64,
    sessions: BTreeMap<String, Session>,
    changed: BTreeSet<String>,
}

impl Default for PreviewSessions {
    fn default() -> Self {
        Self {
            // A volatile backend's new_id can restart its counter on reopen.
            // Use the same random runtime identity source as Document writers.
            scope: loro::LoroDoc::new().peer_id().to_string(),
            next_id: 0,
            sequence: 0,
            sessions: BTreeMap::new(),
            changed: BTreeSet::new(),
        }
    }
}

impl PreviewSessions {
    fn token(&mut self) -> String {
        self.next_id = self.next_id.checked_add(1).expect("preview ID exhausted");
        format!("{}:{}", self.scope, self.next_id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    pub fn document_for_task(&self, task_id: &str) -> Option<String> {
        self.sessions.iter().find_map(|(id, session)| {
            session
                .running
                .as_ref()
                .filter(|ticket| ticket.task_id == task_id)
                .map(|_| id.clone())
        })
    }

    pub fn subscribe(
        &mut self,
        id: &str,
        client: &str,
        snapshot: &TextSnapshot,
        path: &str,
        now: u64,
    ) -> PreviewSubscription {
        let subscription_id = self.token();
        if !self.sessions.contains_key(id) {
            let session_id = self.token();
            let task_id = self.token();
            let supported = supports_preview(path);
            self.sessions.insert(
                id.into(),
                Session {
                    subscribers: BTreeMap::new(),
                    state: PreviewState {
                        target: PreviewTicket {
                            task_id,
                            session_id,
                            document_id: id.into(),
                            version: snapshot.version.clone(),
                            path: path.into(),
                            render_generation: "notist-html-map-v1".into(),
                        },
                        status: if supported {
                            PreviewStatus::Pending
                        } else {
                            PreviewStatus::Unsupported
                        },
                        result: None,
                        error: None,
                        due_at: supported.then_some(now),
                    },
                    running: None,
                    dirty_since: None,
                },
            );
            self.changed.insert(id.into());
        }
        let session = self.sessions.get_mut(id).unwrap();
        session
            .subscribers
            .insert(subscription_id.clone(), client.into());
        PreviewSubscription {
            subscription_id,
            state: session.state.clone(),
        }
    }

    pub fn unsubscribe(&mut self, subscription: &str, client: &str) -> bool {
        let id = self.sessions.iter().find_map(|(id, session)| {
            (session
                .subscribers
                .get(subscription)
                .is_some_and(|owner| owner == client))
            .then(|| id.clone())
        });
        let Some(id) = id else {
            return false;
        };
        let session = self.sessions.get_mut(&id).unwrap();
        session.subscribers.remove(subscription);
        if session.subscribers.is_empty() {
            self.close(&id);
        }
        true
    }

    pub fn release_client(&mut self, client: &str) {
        let mut closed = Vec::new();
        for (id, session) in &mut self.sessions {
            session.subscribers.retain(|_, owner| owner != client);
            if session.subscribers.is_empty() {
                closed.push(id.clone());
            }
        }
        for id in closed {
            self.close(&id);
        }
    }

    pub fn close(&mut self, id: &str) {
        if self.sessions.remove(id).is_some() {
            self.changed.insert(id.into());
        }
    }

    pub fn clear(&mut self) {
        self.changed.extend(self.sessions.keys().cloned());
        self.sessions.clear();
    }

    pub fn reconcile(&mut self, id: &str, version: &Version, path: &str, now: u64) {
        let Some(session) = self.sessions.get(id) else {
            return;
        };
        if session.state.target.version == *version && session.state.target.path == path {
            return;
        }
        let task_id = self.token();
        let session = self.sessions.get_mut(id).unwrap();
        session.state.target.task_id = task_id;
        session.state.target.version = version.clone();
        session.state.target.path = path.into();
        session.state.error = None;
        if supports_preview(path) {
            let first = *session.dirty_since.get_or_insert(now);
            session.state.status = PreviewStatus::Pending;
            session.state.due_at = Some(
                now.saturating_add(PREVIEW_DEBOUNCE_MS)
                    .min(first.saturating_add(PREVIEW_MAX_WAIT_MS)),
            );
        } else {
            session.state.status = PreviewStatus::Unsupported;
            session.state.result = None;
            session.state.due_at = None;
            session.dirty_since = None;
        }
        self.changed.insert(id.into());
    }

    pub fn state(&self, id: &str) -> EditorResult<PreviewState> {
        self.sessions
            .get(id)
            .map(|s| s.state.clone())
            .ok_or_else(|| EditorError::new("NotFound", "Preview session not found", id))
    }

    pub fn take_task(&mut self, id: &str, snapshot: TextSnapshot, now: u64) -> Option<PreviewTask> {
        let session = self.sessions.get_mut(id)?;
        if session.running.is_some()
            || session.state.status != PreviewStatus::Pending
            || session.state.due_at.is_none_or(|deadline| deadline > now)
        {
            return None;
        }
        debug_assert_eq!(session.state.target.version, snapshot.version);
        let ticket = session.state.target.clone();
        session.running = Some(ticket.clone());
        session.state.status = PreviewStatus::Computing;
        session.state.due_at = None;
        session.dirty_since = None;
        self.changed.insert(id.into());
        Some(PreviewTask {
            ticket,
            source: snapshot.text,
        })
    }

    /// Wrong, duplicate or revoked task IDs never mutate the current session.
    pub fn complete(&mut self, completion: PreviewCompletion) -> bool {
        let id = self.sessions.iter().find_map(|(id, session)| {
            session
                .running
                .as_ref()
                .filter(|t| t.task_id == completion.task_id)
                .map(|_| id.clone())
        });
        let Some(id) = id else {
            return false;
        };
        let outcome = match completion.outcome {
            PreviewOutcome::Success { output } => {
                let cached_elsewhere = self
                    .sessions
                    .iter()
                    .filter(|(other, _)| *other != &id)
                    .filter_map(|(_, session)| session.state.result.as_ref())
                    .fold(0usize, |size, result| {
                        size.saturating_add(result.output.bytes())
                    });
                if output.bytes() > MAX_PREVIEW_OUTPUT_BYTES
                    || cached_elsewhere.saturating_add(output.bytes()) > MAX_PREVIEW_CACHE_BYTES
                {
                    PreviewOutcome::Failure {
                        message: "预览内容超过缓存容量，请缩小文档或关闭其他预览。".into(),
                    }
                } else {
                    PreviewOutcome::Success { output }
                }
            }
            other => other,
        };
        let session = self.sessions.get_mut(&id).unwrap();
        let ticket = session.running.take().unwrap();
        if ticket != session.state.target {
            self.changed.insert(id);
            return false;
        }
        match outcome {
            PreviewOutcome::Success { output } => {
                session.state.result = Some(PreviewResult { ticket, output });
                session.state.status = PreviewStatus::Ready;
                session.state.error = None;
            }
            PreviewOutcome::Failure { message } => {
                session.state.status = PreviewStatus::Failed;
                session.state.error = Some(message);
            }
        }
        self.changed.insert(id);
        true
    }

    pub fn retry(&mut self, id: &str, now: u64) -> EditorResult<()> {
        self.state(id)?;
        let task_id = self.token();
        let session_id = self.token();
        let session = self.sessions.get_mut(id).unwrap();
        session.state.target.task_id = task_id;
        session.state.target.session_id = session_id;
        session.running = None;
        session.state.error = None;
        session.dirty_since = None;
        let supported = supports_preview(&session.state.target.path);
        session.state.status = if supported {
            PreviewStatus::Pending
        } else {
            PreviewStatus::Unsupported
        };
        session.state.due_at = supported.then_some(now);
        self.changed.insert(id.into());
        Ok(())
    }

    /// Coalesce undelivered states; assign sequence numbers on delivery so a
    /// slow consumer sees continuous events without retaining every HTML copy.
    pub fn take_events(&mut self) -> Vec<PreviewEvent> {
        std::mem::take(&mut self.changed)
            .into_iter()
            .map(|id| {
                self.sequence = self
                    .sequence
                    .checked_add(1)
                    .expect("preview event sequence exhausted");
                PreviewEvent {
                    sequence: self.sequence,
                    state: self.sessions.get(&id).map(|s| s.state.clone()),
                    document_id: id,
                }
            })
            .collect()
    }
}
