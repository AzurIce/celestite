//! Stable positions and display deltas; neither one is a text mutation path.
use super::*;
use history::version_vector;
use loro::{
    ContainerTrait,
    cursor::{Cursor, Side},
};

impl Buffer {
    /// Before-affinity binds to the preceding character, after-affinity to the
    /// following one. At outer boundaries they bind to start/end respectively.
    /// Deleting the referenced character collapses the anchor to Loro's retained
    /// deletion gap; resolving returns a refreshed anchor with the same affinity.
    pub fn anchor_at(&self, offset: usize, affinity: Affinity) -> Result<Anchor, CoreError> {
        let text = self.text.clone();
        let value = text.to_string();
        let byte = utf16_to_byte(&value, offset)?;
        let index = value[..byte].chars().count();
        let target = match affinity {
            Affinity::Before if offset == 0 => AnchorTarget::Start,
            Affinity::After if byte == value.len() => AnchorTarget::End,
            _ => {
                let after = affinity == Affinity::Before;
                let cursor = text
                    .get_cursor(if after { index - 1 } else { index }, Side::Middle)
                    .ok_or_else(|| CoreError::AnchorUnavailable {
                        message: "missing character".into(),
                    })?;
                AnchorTarget::Character {
                    cursor: cursor.encode(),
                    after,
                }
            }
        };
        Ok(Anchor {
            identity: self.identity.clone(),
            affinity,
            target,
        })
    }

    pub fn resolve_anchor(&self, anchor: &Anchor) -> Result<ResolvedAnchor, CoreError> {
        self.check_identity(&anchor.identity)?;
        let text = self.text.clone();
        let value = text.to_string();
        let offset = match &anchor.target {
            AnchorTarget::Start => 0,
            AnchorTarget::End => value.encode_utf16().count(),
            AnchorTarget::Character { cursor, after } => {
                let cursor = Cursor::decode(cursor).map_err(|e| CoreError::AnchorUnavailable {
                    message: e.to_string(),
                })?;
                if cursor.container != text.id() || cursor.id.is_none() {
                    return Err(CoreError::AnchorUnavailable {
                        message: "not a source character".into(),
                    });
                }
                let resolved =
                    self.doc
                        .get_cursor_pos(&cursor)
                        .map_err(|e| CoreError::AnchorUnavailable {
                            message: e.to_string(),
                        })?;
                let index = resolved.current.pos + usize::from(*after && resolved.update.is_none());
                value.chars().take(index).map(char::len_utf16).sum()
            }
        };
        Ok(ResolvedAnchor {
            offset,
            refreshed: self.anchor_at(offset, anchor.affinity)?,
        })
    }

    pub(super) fn undo_cursors_at(
        &self,
        value: &str,
        positions: &[usize],
    ) -> Result<Vec<Cursor>, CoreError> {
        let text = self.text.clone();
        positions
            .iter()
            .map(|offset| {
                let byte = utf16_to_byte(&value, *offset)?;
                text.get_cursor(value[..byte].chars().count(), Side::Middle)
                    .ok_or(CoreError::InvalidPosition { offset: *offset })
            })
            .collect()
    }

    /// Causal display delta keeps unchanged islands (and selections anchored
    /// there) intact, even when a remote packet edits distant regions.
    pub(super) fn display_delta(&self, before: &TextSnapshot) -> Option<Vec<TextEdit>> {
        let from = self
            .doc
            .vv_to_frontiers(&version_vector(&before.version).ok()?);
        let batch = self.doc.diff(&from, &self.doc.state_frontiers()).ok()?;
        let mut characters = before.text.chars();
        let mut offset = 0usize;
        let mut edits: Vec<TextEdit> = vec![];
        for (id, diff) in batch.iter() {
            if *id != self.text.clone().id() {
                continue;
            }
            let loro::event::Diff::Text(delta) = diff else {
                return None;
            };
            for part in delta {
                match part {
                    loro::TextDelta::Retain { retain, .. } => {
                        for _ in 0..*retain {
                            offset += characters.next()?.len_utf16();
                        }
                    }
                    loro::TextDelta::Insert { insert, .. } => {
                        let pos = offset;
                        if let Some(edit) = edits.last_mut().filter(|e| e.to == pos) {
                            edit.insert.push_str(insert);
                        } else {
                            edits.push(TextEdit {
                                from: pos,
                                to: pos,
                                insert: insert.clone(),
                            });
                        }
                    }
                    loro::TextDelta::Delete { delete } => {
                        let from = offset;
                        for _ in 0..*delete {
                            offset += characters.next()?.len_utf16();
                        }
                        let to = offset;
                        if let Some(edit) = edits.last_mut().filter(|e| e.to == from) {
                            edit.to = to;
                        } else {
                            edits.push(TextEdit {
                                from,
                                to,
                                insert: String::new(),
                            });
                        }
                    }
                }
            }
        }
        Some(edits)
    }
}
