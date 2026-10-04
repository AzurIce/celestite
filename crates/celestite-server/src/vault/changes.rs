//! Invalidation feed, serialized by the same lock as the host core.
//! It carries committed causal versions, never text or operation acknowledgements.
use super::{fs::Result, store::VaultIdentity};
use celestite_core::{EditorDocument, Version};
use serde::Serialize;
use std::collections::BTreeMap;
use tokio::sync::broadcast;

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentNotice {
    id: String,
    path: String,
    version: Option<Version>,
    saved_version: Option<Version>,
    backend_revision: String,
    dirty: bool,
    deleted: bool,
    conflict: bool,
    available: bool,
    error: Option<String>,
    persistence_error: Option<String>,
}
pub(crate) fn exportable(state: &EditorDocument, persistent: bool) -> bool {
    state.persistence_error.is_none()
        && (!persistent || state.durable_version.as_ref() == Some(&state.snapshot.version))
}
impl DocumentNotice {
    fn from_state(state: EditorDocument, persistent: bool) -> Self {
        let available = exportable(&state, persistent);
        Self {
            id: state.id,
            path: state.path,
            version: if persistent {
                state.durable_version
            } else if available {
                Some(state.snapshot.version)
            } else {
                None
            },
            saved_version: state.saved_version,
            backend_revision: state.backend_revision,
            dirty: state.dirty,
            deleted: state.deleted,
            conflict: state.conflict,
            available,
            error: state.error,
            persistence_error: state.persistence_error,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentEvent {
    pub kind: &'static str,
    pub stream_id: String,
    pub sequence: u64,
    pub vault_identity: VaultIdentity,
    pub persistent_history: bool,
    pub documents: Vec<DocumentNotice>,
}
pub(crate) struct Subscription {
    pub initial: DocumentEvent,
    pub receiver: broadcast::Receiver<DocumentEvent>,
}
pub(crate) struct DocumentFeed {
    stream_id: String,
    identity: VaultIdentity,
    persistent: bool,
    sequence: u64,
    states: BTreeMap<String, DocumentNotice>,
    sender: broadcast::Sender<DocumentEvent>,
}
impl DocumentFeed {
    pub fn new(identity: VaultIdentity, persistent: bool) -> Self {
        Self {
            stream_id: uuid::Uuid::new_v4().to_string(),
            identity,
            persistent,
            sequence: 0,
            states: BTreeMap::new(),
            sender: broadcast::channel(128).0,
        }
    }
    pub fn publish(&mut self, states: Vec<EditorDocument>) -> Result<bool> {
        let states: BTreeMap<_, _> = states
            .into_iter()
            .map(|state| {
                let notice = DocumentNotice::from_state(state, self.persistent);
                (notice.id.clone(), notice)
            })
            .collect();
        let changed: Vec<_> = states
            .iter()
            .filter(|(id, notice)| self.states.get(*id) != Some(*notice))
            .map(|(_, notice)| notice.clone())
            .collect();
        if changed.is_empty() {
            return Ok(false);
        }
        self.sequence = self.sequence.checked_add(1).ok_or_else(|| {
            super::fs::VaultError::new("IO", "Document feed counter exhausted", "")
        })?;
        self.states = states;
        let _ = self.sender.send(self.event("changed", changed));
        Ok(true)
    }
    fn event(&self, kind: &'static str, documents: Vec<DocumentNotice>) -> DocumentEvent {
        DocumentEvent {
            kind,
            stream_id: self.stream_id.clone(),
            sequence: self.sequence,
            vault_identity: self.identity.clone(),
            persistent_history: self.persistent,
            documents,
        }
    }
    /// Caller holds the core lock across publishing, subscription and this snapshot.
    pub fn subscribe(&self) -> Subscription {
        let receiver = self.sender.subscribe();
        Subscription {
            initial: self.event("resync", self.states.values().cloned().collect()),
            receiver,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::documents::Documents;
    use serde_json::Value;

    fn state(documents: &Documents) -> EditorDocument {
        documents.resident().unwrap().pop().unwrap()
    }
    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Documents) {
        let root = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), "base").unwrap();
        let mut documents = Documents::open(
            Some(&history.path().join("history.redb")),
            root.path(),
            crate::HistoryMode::Initialize,
        )
        .unwrap();
        documents.reconcile().unwrap();
        documents.publish_changes().unwrap();
        (root, history, documents)
    }
    #[test]
    fn lagged_subscribers_can_atomically_replace_the_snapshot_and_receiver() {
        let (_root, _history, documents) = fixture();
        let mut feed = DocumentFeed::new(documents.identity.clone(), true);
        feed.publish(vec![state(&documents)]).unwrap();
        let mut old = feed.subscribe();
        for revision in 0..140 {
            let mut state = state(&documents);
            state.backend_revision = format!("disk-{revision}");
            feed.publish(vec![state]).unwrap();
        }
        assert!(matches!(
            old.receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        let mut new = feed.subscribe();
        assert_eq!(new.initial.sequence, feed.sequence);
        let value = serde_json::to_value(&new.initial).unwrap();
        assert_eq!(value["documents"][0]["backendRevision"], "disk-139");
        let mut next = state(&documents);
        next.backend_revision = "next".into();
        feed.publish(vec![next]).unwrap();
        assert_eq!(
            new.receiver.try_recv().unwrap().sequence,
            new.initial.sequence + 1
        );
    }
    #[test]
    fn failed_history_is_announced_without_claiming_the_uncommitted_version() {
        let (_root, _history, documents) = fixture();
        let mut feed = DocumentFeed::new(documents.identity.clone(), true);
        let initial = state(&documents);
        let committed = initial.snapshot.version.clone();
        feed.publish(vec![initial]).unwrap();
        let mut subscription = feed.subscribe();
        let mut failed = state(&documents);
        *failed.snapshot.version.clocks.values_mut().next().unwrap() += 1;
        failed.snapshot.text = "unconfirmed draft".into();
        failed.persistence_error = Some("injected failed commit".into());
        assert!(!exportable(&failed, true));
        feed.publish(vec![failed]).unwrap();
        let event: Value = serde_json::to_value(subscription.receiver.try_recv().unwrap()).unwrap();
        assert_eq!(
            event["documents"][0]["version"],
            serde_json::to_value(committed).unwrap()
        );
        assert_eq!(event["documents"][0]["available"], false);
        assert!(!serde_json::to_string(&event)
            .unwrap()
            .contains("unconfirmed draft"));
        // Repeating the same status does not create a new notification.
        let current = feed.sequence;
        let mut failed = state(&documents);
        failed.persistence_error = Some("injected failed commit".into());
        assert!(!feed.publish(vec![failed]).unwrap());
        assert_eq!(feed.sequence, current);
    }
}
