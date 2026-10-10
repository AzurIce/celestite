//! Online membership is volatile and independent of text history and Loro peers.
use celestite_buffer::types::{Anchor, Version};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresenceSelection {
    pub version: Version,
    pub ranges: Vec<PresenceRange>,
    pub main_index: usize,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) struct PresenceRange {
    pub anchor: Anchor,
    pub head: Anchor,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberView {
    pub view_id: String,
    pub document_id: String,
    pub focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<PresenceSelection>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Member {
    pub session_id: String,
    pub read_only: bool,
    pub name: String,
    pub color: String,
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
            let palette = [
                "#2563eb", "#c026d3", "#0d9488", "#ea580c", "#7c3aed", "#db2777", "#0284c7",
                "#65a30d",
            ];
            let start = session_id.bytes().fold(0_usize, |hash, byte| {
                hash.wrapping_mul(31).wrapping_add(byte as usize)
            }) % palette.len();
            let color = (0..palette.len())
                .map(|offset| palette[(start + offset) % palette.len()])
                .find(|color| members.values().all(|member| member.color != *color))
                .unwrap_or(palette[start]);
            members.insert(
                session_id.into(),
                Member {
                    session_id: session_id.into(),
                    read_only,
                    name: format!(
                        "访客 {}",
                        session_id
                            .chars()
                            .take(4)
                            .collect::<String>()
                            .to_uppercase()
                    ),
                    color: color.into(),
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
    pub fn view(&self, session_id: &str, view_id: &str, view: Option<MemberView>) -> bool {
        let mut accepted = false;
        self.update(|members| {
            let Some(member) = members.get_mut(session_id) else {
                return false;
            };
            let existing = member.views.iter().position(|v| v.view_id == view_id);
            if view.is_some() && existing.is_none() && member.views.len() >= 64 {
                return false;
            }
            accepted = true;
            if existing.map(|i| &member.views[i]) == view.as_ref() {
                return false;
            }
            member.views.retain(|existing| existing.view_id != view_id);
            if let Some(view) = view {
                if view.focused {
                    for other in &mut member.views {
                        other.focused = false;
                    }
                }
                member.views.push(view);
            }
            true
        });
        accepted
    }
    pub fn subscribe(&self) -> watch::Receiver<Members> {
        self.updates.subscribe()
    }
}
