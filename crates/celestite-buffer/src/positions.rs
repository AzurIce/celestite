//! Stable positions and display deltas; neither one is a text mutation path.
use crate::{
    Buffer,
    types::{Affinity, Anchor, AnchorTarget, BufferError, TextEdit, TextSnapshot},
};
use loro::{
    ContainerTrait,
    cursor::{Cursor, PosType, Side},
};

/// A native position resolved against a Buffer's current text.
pub trait ToOffset {
    fn to_offset(&self, buffer: &Buffer) -> Result<usize, BufferError>;
}

impl ToOffset for usize {
    fn to_offset(&self, buffer: &Buffer) -> Result<usize, BufferError> {
        buffer.scalar_index(*self)?;
        Ok(*self)
    }
}

impl<T: ToOffset + ?Sized> ToOffset for &T {
    fn to_offset(&self, buffer: &Buffer) -> Result<usize, BufferError> {
        (*self).to_offset(buffer)
    }
}

impl ToOffset for Anchor {
    fn to_offset(&self, buffer: &Buffer) -> Result<usize, BufferError> {
        Anchor::to_offset(self, buffer)
    }
}

impl Anchor {
    pub fn to_offset(&self, buffer: &Buffer) -> Result<usize, BufferError> {
        buffer.anchor_offset(self)
    }
}

impl Buffer {
    /// Loro conversions round positions inside scalars; a round trip validates
    /// the boundary without scanning or materializing the entire text.
    pub(super) fn scalar_index(&self, offset: usize) -> Result<usize, BufferError> {
        let index = self
            .text
            .convert_pos(offset, PosType::Bytes, PosType::Unicode)
            .ok_or(BufferError::InvalidPosition { offset })?;
        if self
            .text
            .convert_pos(index, PosType::Unicode, PosType::Bytes)
            != Some(offset)
        {
            return Err(BufferError::InvalidPosition { offset });
        }
        Ok(index)
    }

    pub(super) fn byte_index(&self, index: usize) -> usize {
        self.text
            .convert_pos(index, PosType::Unicode, PosType::Bytes)
            .expect("valid source scalar position")
    }

    pub fn anchor_before<P: ToOffset>(&self, position: P) -> Result<Anchor, BufferError> {
        self.anchor_at(position, Affinity::Before)
    }

    pub fn anchor_after<P: ToOffset>(&self, position: P) -> Result<Anchor, BufferError> {
        self.anchor_at(position, Affinity::After)
    }

    /// Before-affinity binds to the preceding character, after-affinity to the
    /// following one. At outer boundaries they bind to start/end respectively.
    /// Deleting the referenced character collapses the anchor to Loro's retained
    /// deletion gap even when resolved repeatedly from the original anchor.
    pub fn anchor_at<P: ToOffset>(
        &self,
        position: P,
        affinity: Affinity,
    ) -> Result<Anchor, BufferError> {
        let offset = position.to_offset(self)?;
        let index = self.scalar_index(offset)?;
        let target = match affinity {
            Affinity::Before if offset == 0 => AnchorTarget::Start,
            Affinity::After if offset == self.len() => AnchorTarget::End,
            _ => {
                let after = affinity == Affinity::Before;
                let cursor = self
                    .text
                    .get_cursor(if after { index - 1 } else { index }, Side::Middle)
                    .ok_or_else(|| BufferError::AnchorUnavailable {
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

    fn anchor_offset(&self, anchor: &Anchor) -> Result<usize, BufferError> {
        self.check_identity(&anchor.identity)?;
        let offset = match &anchor.target {
            AnchorTarget::Start => 0,
            AnchorTarget::End => self.len(),
            AnchorTarget::Character { cursor, after } => {
                let cursor =
                    Cursor::decode(cursor).map_err(|e| BufferError::AnchorUnavailable {
                        message: e.to_string(),
                    })?;
                if cursor.container != self.text.id() || cursor.id.is_none() {
                    return Err(BufferError::AnchorUnavailable {
                        message: "not a source character".into(),
                    });
                }
                let resolved = self.doc.get_cursor_pos(&cursor).map_err(|e| {
                    BufferError::AnchorUnavailable {
                        message: e.to_string(),
                    }
                })?;
                let index = resolved.current.pos + usize::from(*after && resolved.update.is_none());
                self.byte_index(index)
            }
        };
        Ok(offset)
    }

    pub(super) fn undo_cursors_at(&self, positions: &[usize]) -> Result<Vec<Cursor>, BufferError> {
        positions
            .iter()
            .map(|offset| {
                let index = self.scalar_index(*offset)?;
                self.text
                    .get_cursor(index, Side::Middle)
                    .ok_or(BufferError::InvalidPosition { offset: *offset })
            })
            .collect()
    }

    /// Causal display delta keeps unchanged islands (and selections anchored
    /// there) intact, even when a remote packet edits distant regions.
    pub(super) fn display_delta(&self, before: &TextSnapshot) -> Option<Vec<TextEdit>> {
        let from = self.doc.vv_to_frontiers(before.version.vector());
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
                            offset += characters.next()?.len_utf8();
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
                            offset += characters.next()?.len_utf8();
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
