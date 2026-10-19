//! Invalidation feed, serialized by the same lock as the host core.
//! It carries committed causal versions, never text or operation acknowledgements.
use celestite_core::editor::types::DocumentStatus;
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use celestite_core::instance::Vault;
use serde::Serialize;
use std::collections::BTreeMap;
use tokio::sync::broadcast;

/// File tree invalidation sent by the server's SSE stream.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct ChangeHint {
    paths: Vec<String>,
    recursive: bool,
}
impl ChangeHint {
    pub(crate) fn all() -> Self {
        Self {
            paths: vec![String::new()],
            recursive: true,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub(crate) struct DocumentNotice {
    #[serde(flatten)]
    pub(crate) status: DocumentStatus,
    /// Whether this document can currently be exported to a session.
    available: bool,
}
pub(crate) fn exportable(state: &DocumentStatus) -> bool {
    state.recovery_error.is_none()
}
impl DocumentNotice {
    fn from_state(status: DocumentStatus) -> Self {
        let available = exportable(&status);
        Self { status, available }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentEvent {
    pub kind: &'static str,
    pub stream_id: String,
    pub sequence: u64,
    pub vault: Vault,
    pub documents: Vec<DocumentNotice>,
}
pub(crate) struct Subscription {
    pub initial: DocumentEvent,
    pub receiver: broadcast::Receiver<DocumentEvent>,
}
pub(crate) struct DocumentFeed {
    stream_id: String,
    identity: Vault,
    sequence: u64,
    states: BTreeMap<String, DocumentNotice>,
    sender: broadcast::Sender<DocumentEvent>,
}
impl DocumentFeed {
    pub fn new(identity: Vault) -> Self {
        Self {
            stream_id: uuid::Uuid::new_v4().to_string(),
            identity,
            sequence: 0,
            states: BTreeMap::new(),
            sender: broadcast::channel(128).0,
        }
    }
    pub fn publish(&mut self, states: Vec<DocumentStatus>) -> EditorResult<bool> {
        let states: BTreeMap<_, _> = states
            .into_iter()
            .map(|state| {
                let notice = DocumentNotice::from_state(state);
                (notice.status.id.clone(), notice)
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
            EditorError::new(ErrorCode::Io, "Document feed counter exhausted", "")
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
            vault: self.identity.clone(),
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
    use super::{exportable, DocumentFeed};
    use crate::vault::documents::Documents;
    use celestite_core::editor::types::DocumentStatus;
    use serde_json::Value;
    use tokio::sync::broadcast;

    fn state(documents: &Documents) -> DocumentStatus {
        documents
            .resident()
            .unwrap()
            .into_iter()
            .map(|state| {
                documents
                    .host_document(&state.status.id, None)
                    .unwrap()
                    .status
            })
            .next()
            .unwrap()
    }
    fn fixture() -> (tempfile::TempDir, Documents) {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), "base").unwrap();
        let mut documents = Documents::open(root.path(), &[0; 32]).unwrap();
        documents.open_file("a.md").unwrap();
        documents.publish_changes().unwrap();
        (root, documents)
    }
    #[test]
    fn lagged_subscribers_can_atomically_replace_the_snapshot_and_receiver() {
        let (_root, documents) = fixture();
        let mut feed = DocumentFeed::new(documents.identity.clone());
        feed.publish(vec![state(&documents)]).unwrap();
        let mut old = feed.subscribe();
        for revision in 0..140 {
            let mut state = state(&documents);
            state.file_revision = format!("disk-{revision}");
            feed.publish(vec![state]).unwrap();
        }
        assert!(matches!(
            old.receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        let mut new = feed.subscribe();
        assert_eq!(new.initial.sequence, feed.sequence);
        let value = serde_json::to_value(&new.initial).unwrap();
        assert_eq!(value["documents"][0]["fileRevision"], "disk-139");
        let mut next = state(&documents);
        next.file_revision = "next".into();
        feed.publish(vec![next]).unwrap();
        assert_eq!(
            new.receiver.try_recv().unwrap().sequence,
            new.initial.sequence + 1
        );
    }
    #[test]
    fn accepted_history_is_available_without_a_recovery_error() {
        let (_root, documents) = fixture();
        let mut feed = DocumentFeed::new(documents.identity.clone());
        let initial = state(&documents);
        assert!(initial.recovery_error.is_none());
        assert!(exportable(&initial));
        let version = initial.version.clone();
        feed.publish(vec![initial]).unwrap();
        let event: Value = serde_json::to_value(feed.subscribe().initial).unwrap();
        assert!(event.get("persistentHistory").is_none());
        assert!(event["documents"][0].get("persistedVersion").is_none());
        assert!(event["documents"][0]["recoveryError"].is_null());
        assert_eq!(
            event["documents"][0]["version"],
            serde_json::to_value(version).unwrap()
        );
        assert_eq!(event["documents"][0]["available"], true);
    }
}
