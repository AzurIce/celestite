//! Independent preview ownership. Only source metadata persists here; text is
//! borrowed from an atomic source capture when issuing an immutable task.
use super::{
    MAX_PREVIEW_CACHE_BYTES, MAX_PREVIEW_OUTPUT_BYTES, PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS,
    PreviewCompletion, PreviewEvent, PreviewLink, PreviewOutcome, PreviewResult, PreviewState,
    PreviewStatus, PreviewSubscription, PreviewTask, PreviewTicket, default_resource_root,
    diagnostic_bytes, resolve_preview_target, supports_preview,
};
use crate::backend::{EditorError, EditorResult};
use crate::source::{DocumentSourceSnapshot, SourceDocument};
use celestite_buffer::new_peer_id;
use celestite_buffer::types::{TextSnapshot, Version};
use std::collections::{BTreeMap, BTreeSet};

struct Session {
    subscribers: BTreeMap<String, String>,
    state: PreviewState,
    running: Option<PreviewTicket>,
    dirty_since: Option<u64>,
}

struct PreviewSessions {
    scope: String,
    next_id: u64,
    sequence: u64,
    sessions: BTreeMap<String, Session>,
    changed: BTreeSet<String>,
    generation: u64,
}

impl Default for PreviewSessions {
    fn default() -> Self {
        Self {
            // A volatile backend's new_id can restart its counter on reopen.
            // Use the same ephemeral identity source as Buffer peers.
            scope: new_peer_id().to_string(),
            next_id: 0,
            sequence: 0,
            sessions: BTreeMap::new(),
            changed: BTreeSet::new(),
            generation: 0,
        }
    }
}

impl PreviewSessions {
    pub fn invalidate_project(&mut self, now: u64) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("preview generation exhausted");
        let ids: Vec<_> = self.sessions.keys().cloned().collect();
        for id in ids {
            let task_id = self.token();
            let session = self.sessions.get_mut(&id).unwrap();
            session.state.target.task_id = task_id;
            session.state.target.render_generation =
                format!("notist-project-v1:{}", self.generation);
            session.state.error = None;
            session.state.diagnostics.clear();
            if supports_preview(&session.state.target.path) {
                let first = *session.dirty_since.get_or_insert(now);
                session.state.status = PreviewStatus::Pending;
                session.state.due_at = Some(
                    now.saturating_add(PREVIEW_DEBOUNCE_MS)
                        .min(first.saturating_add(PREVIEW_MAX_WAIT_MS)),
                );
            }
            self.changed.insert(id);
        }
    }

    fn token(&mut self) -> String {
        self.next_id = self.next_id.checked_add(1).expect("preview ID exhausted");
        format!("{}:{}", self.scope, self.next_id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    fn subscribe_metadata(
        &mut self,
        id: &str,
        client: &str,
        version: &Version,
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
                            version: version.clone(),
                            path: path.into(),
                            render_generation: format!("notist-project-v1:{}", self.generation),
                        },
                        status: if supported {
                            PreviewStatus::Pending
                        } else {
                            PreviewStatus::Unsupported
                        },
                        result: None,
                        error: None,
                        diagnostics: vec![],
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

    fn replace_source(&mut self, now: u64) {
        self.invalidate_project(now);
        let ids: Vec<_> = self.sessions.keys().cloned().collect();
        for id in ids {
            let session_id = self.token();
            let session = self.sessions.get_mut(&id).unwrap();
            session.state.target.session_id = session_id;
            session.running = None;
            session.dirty_since = None;
            session.state.due_at = supports_preview(&session.state.target.path).then_some(now);
        }
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
        session.state.diagnostics.clear();
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
            source: snapshot.text.to_string(),
            overlays: BTreeMap::new(),
            resources: BTreeMap::new(),
            resource_root: default_resource_root(),
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
        let cached_elsewhere = self
            .sessions
            .iter()
            .filter(|(other, _)| *other != &id)
            .fold(0usize, |size, (_, session)| {
                size.saturating_add(
                    session
                        .state
                        .result
                        .as_ref()
                        .map_or(0, |result| result.output.bytes()),
                )
                .saturating_add(diagnostic_bytes(&session.state.diagnostics))
            });
        let outcome = match completion.outcome {
            PreviewOutcome::Success { output } => {
                if output.bytes() > MAX_PREVIEW_OUTPUT_BYTES
                    || cached_elsewhere.saturating_add(output.bytes()) > MAX_PREVIEW_CACHE_BYTES
                {
                    PreviewOutcome::Failure {
                        message: "预览内容超过缓存容量，请缩小文档或关闭其他预览。".into(),
                        diagnostics: vec![],
                    }
                } else {
                    PreviewOutcome::Success { output }
                }
            }
            PreviewOutcome::Failure {
                message,
                mut diagnostics,
            } => {
                let bytes = diagnostic_bytes(&diagnostics);
                let retained = self.sessions[&id]
                    .state
                    .result
                    .as_ref()
                    .map_or(0, |result| result.output.bytes());
                if bytes > MAX_PREVIEW_OUTPUT_BYTES
                    || cached_elsewhere
                        .saturating_add(retained)
                        .saturating_add(bytes)
                        > MAX_PREVIEW_CACHE_BYTES
                {
                    diagnostics.clear();
                }
                PreviewOutcome::Failure {
                    message,
                    diagnostics,
                }
            }
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
                session.state.diagnostics.clear();
            }
            PreviewOutcome::Failure {
                message,
                diagnostics,
            } => {
                session.state.status = PreviewStatus::Failed;
                session.state.error = Some(message);
                session.state.diagnostics = diagnostics;
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
        session.state.diagnostics.clear();
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

#[derive(Default)]
pub struct PreviewController {
    sessions: PreviewSessions,
    documents: BTreeMap<String, SourceDocument>,
    environment: BTreeMap<String, Version>,
    epoch: Option<u64>,
}

impl PreviewController {
    /// Reconcile a complete live catalogue without reading or retaining bodies.
    /// Replacement revokes executors; ordinary edits retain late-result handling.
    pub fn synchronize(&mut self, source: &DocumentSourceSnapshot, now: u64) -> bool {
        let replaced = self.epoch != Some(source.epoch);
        let documents: BTreeMap<_, _> = source
            .documents
            .iter()
            .map(|document| (document.id.clone(), document.clone()))
            .collect();
        let environment = documents
            .values()
            .filter(|document| !supports_preview(&document.path))
            .map(|document| (document.path.clone(), document.version.clone()))
            .collect();
        let closed: Vec<_> = self
            .sessions
            .sessions
            .keys()
            .filter(|id| !documents.contains_key(*id))
            .cloned()
            .collect();
        for id in closed {
            self.sessions.close(&id);
        }
        for document in documents.values() {
            self.sessions
                .reconcile(&document.id, &document.version, &document.path, now);
        }
        if replaced {
            self.sessions.replace_source(now);
        } else if self.environment != environment {
            self.sessions.invalidate_project(now);
        }
        self.documents = documents;
        self.environment = environment;
        self.epoch = Some(source.epoch);
        replaced
    }

    fn document(&self, id: &str) -> EditorResult<&SourceDocument> {
        self.documents
            .get(id)
            .ok_or_else(|| EditorError::new("NotFound", "Source document not found", id))
    }

    pub fn subscribe(
        &mut self,
        id: &str,
        client: &str,
        now: u64,
    ) -> EditorResult<PreviewSubscription> {
        if client.is_empty() {
            return Err(EditorError::new(
                "InvalidPreview",
                "Missing client session",
                id,
            ));
        }
        let document = self.document(id)?.clone();
        Ok(self
            .sessions
            .subscribe_metadata(id, client, &document.version, &document.path, now))
    }

    pub fn unsubscribe(&mut self, subscription: &str, client: &str) -> bool {
        self.sessions.unsubscribe(subscription, client)
    }

    pub fn release_client(&mut self, client: &str) {
        self.sessions.release_client(client);
    }

    pub fn state(&self, id: &str) -> EditorResult<PreviewState> {
        self.sessions.state(id)
    }

    pub fn required_snapshots(&self, id: &str) -> EditorResult<Vec<String>> {
        self.document(id)?;
        let mut ids = vec![id.to_owned()];
        ids.extend(
            self.documents
                .values()
                .filter(|document| document.id != id && !supports_preview(&document.path))
                .map(|document| document.id.clone()),
        );
        Ok(ids)
    }

    pub fn take_task(
        &mut self,
        id: &str,
        source: &DocumentSourceSnapshot,
        now: u64,
    ) -> EditorResult<Option<PreviewTask>> {
        self.synchronize(source, now);
        self.document(id)?;
        if !self.sessions.contains(id) {
            return Ok(None);
        }
        let required = self.required_snapshots(id)?;
        let mut selected = BTreeMap::new();
        for required_id in required {
            let document = &self.documents[&required_id];
            let mut matches = source
                .snapshots
                .iter()
                .filter(|body| body.id == required_id);
            let body = matches.next().ok_or_else(|| {
                EditorError::new(
                    "StaleVersion",
                    "Required preview snapshot missing",
                    &required_id,
                )
            })?;
            if matches.next().is_some()
                || body.path != document.path
                || body.snapshot.version != document.version
            {
                return Err(EditorError::new(
                    "StaleVersion",
                    "Preview snapshot does not match source catalogue",
                    &required_id,
                ));
            }
            selected.insert(required_id, body);
        }
        let Some(mut task) = self
            .sessions
            .take_task(id, selected[id].snapshot.clone(), now)
        else {
            return Ok(None);
        };
        task.overlays = selected
            .values()
            .filter(|body| !supports_preview(&body.path))
            .map(|body| (body.path.clone(), body.snapshot.text.to_string()))
            .collect();
        if task
            .overlays
            .values()
            .fold(0usize, |size, text| size.saturating_add(text.len()))
            > 32 * 1024 * 1024
        {
            self.sessions.complete(PreviewCompletion {
                task_id: task.ticket.task_id,
                outcome: PreviewOutcome::Failure {
                    message: "预览项目的未保存内容超过容量，请关闭部分文件。".into(),
                    diagnostics: vec![],
                },
            });
            return Ok(None);
        }
        Ok(Some(task))
    }

    pub fn complete(&mut self, completion: PreviewCompletion) -> bool {
        self.sessions.complete(completion)
    }

    pub fn retry(&mut self, id: &str, now: u64) -> EditorResult<PreviewState> {
        self.document(id)?;
        self.sessions.retry(id, now)?;
        self.sessions.state(id)
    }

    pub fn take_events(&mut self) -> Vec<PreviewEvent> {
        self.sessions.take_events()
    }

    pub fn invalidate_project(&mut self, now: u64) {
        self.sessions.invalidate_project(now);
    }

    pub fn clear(&mut self) {
        self.sessions.clear();
        self.documents.clear();
        self.environment.clear();
        self.epoch = None;
    }

    pub fn link(&self, id: &str, task_id: &str, target: &str) -> EditorResult<PreviewLink> {
        let state = self.state(id)?;
        if state.status != PreviewStatus::Ready
            || state.target.task_id != task_id
            || state
                .result
                .as_ref()
                .is_none_or(|result| result.ticket != state.target)
        {
            return Err(EditorError::new(
                "StaleVersion",
                "预览正在更新，请稍后再打开链接。",
                id,
            ));
        }
        resolve_preview_target(&state.target.path, target)
    }
}
