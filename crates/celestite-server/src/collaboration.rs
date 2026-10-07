//! Online membership is volatile and independent of text history and writers.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberView {
    pub view_id: String,
    pub document_id: String,
    pub focused: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Member {
    pub session_id: String,
    pub read_only: bool,
    pub documents: Vec<String>,
    pub views: Vec<MemberView>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Members {
    pub sequence: u64,
    pub members: Vec<Member>,
}
pub(crate) struct CollaborationState {
    members: Mutex<BTreeMap<String, Member>>,
    updates: watch::Sender<Members>,
}
impl CollaborationState {
    pub fn new() -> Self {
        Self {
            members: Mutex::new(BTreeMap::new()),
            updates: watch::channel(Members {
                sequence: 0,
                members: vec![],
            })
            .0,
        }
    }
    fn update(&self, action: impl FnOnce(&mut BTreeMap<String, Member>) -> bool) {
        let mut members = self.members.lock().expect("membership lock poisoned");
        if action(&mut members) {
            self.updates.send_modify(|snapshot| {
                snapshot.sequence += 1;
                snapshot.members = members.values().cloned().collect();
            });
        }
    }
    pub fn join(&self, session_id: &str, read_only: bool) {
        self.update(|members| {
            members.insert(
                session_id.into(),
                Member {
                    session_id: session_id.into(),
                    read_only,
                    documents: vec![],
                    views: vec![],
                },
            );
            true
        });
    }
    pub fn leave(&self, session_id: &str) {
        self.update(|members| members.remove(session_id).is_some());
    }
    pub fn documents(&self, session_id: &str, documents: Vec<String>) {
        self.update(|members| {
            let Some(member) = members.get_mut(session_id) else {
                return false;
            };
            if member.documents == documents {
                return false;
            }
            member
                .views
                .retain(|view| documents.contains(&view.document_id));
            member.documents = documents;
            true
        });
    }
    pub fn view(&self, session_id: &str, view_id: &str, view: Option<MemberView>) {
        self.update(|members| {
            let Some(member) = members.get_mut(session_id) else {
                return false;
            };
            member.views.retain(|existing| existing.view_id != view_id);
            if let Some(view) = view {
                member.views.push(view);
            }
            true
        });
    }
    pub fn subscribe(&self) -> watch::Receiver<Members> {
        self.updates.subscribe()
    }
}
