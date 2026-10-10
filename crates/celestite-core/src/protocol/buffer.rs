//! UTF-16 command boundary for a directly owned Buffer.
use super::byte_to_utf16;
use celestite_buffer::Buffer;
use celestite_buffer::text::utf16_to_byte;
use celestite_buffer::types::{
    BufferError, BufferUpdate, ChangeCause, EditOptions, HistoryPacket, ImportOptions,
    TextSnapshot, UndoContext, UndoState, Version,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Deserialize)]
pub(super) struct WireContext {
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    positions: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Input {
    Edits { edits: Vec<WireEdit> },
    Text { text: String },
}

#[derive(Deserialize)]
pub(super) struct WireEdit {
    from: usize,
    to: usize,
    insert: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Command {
    Edit {
        base: Version,
        input: Input,
        #[serde(default)]
        group: Option<String>,
        #[serde(default)]
        undo: WireContext,
    },
    Undo {
        base: Version,
        #[serde(default)]
        context: WireContext,
    },
    Redo {
        base: Version,
        #[serde(default)]
        context: WireContext,
    },
    Import {
        packet: HistoryPacket,
        #[serde(default, rename = "resetUndo")]
        reset_undo: bool,
    },
    ClearUndo,
}

/// Metadata lives at the wire boundary, never in native history.
#[derive(Default)]
pub(super) struct Contexts {
    next: u64,
    values: BTreeMap<u64, Value>,
    reserved: BTreeSet<u64>,
}

impl Contexts {
    pub(super) fn clear(&mut self) {
        self.values.clear();
    }

    pub(super) fn reserve(&mut self, tags: impl IntoIterator<Item = u64>) {
        self.reserved = tags.into_iter().collect();
    }

    pub(super) fn prune(&mut self, live_tags: impl IntoIterator<Item = u64>) {
        let live: std::collections::BTreeSet<_> = live_tags.into_iter().collect();
        self.values.retain(|tag, _| live.contains(tag));
    }

    pub(super) fn context(
        &mut self,
        text: &str,
        context: WireContext,
    ) -> Result<(UndoContext, Option<u64>), BufferError> {
        // Validate positions before allocating a metadata tag.
        let positions = context
            .positions
            .into_iter()
            .map(|position| utf16_to_byte(text, position))
            .collect::<Result<Vec<_>, _>>()?;
        let mut allocated = None;
        let tag = context.metadata.map(|metadata| {
            if let Some((&tag, _)) = self.values.iter().find(|(_, value)| **value == metadata) {
                return tag;
            }
            // A native caller (or another adapter) may already own a tag.
            // Never attach this adapter's JSON to that unrelated context.
            loop {
                self.next = self.next.wrapping_add(1);
                if !self.reserved.contains(&self.next) && !self.values.contains_key(&self.next) {
                    break;
                }
            }
            self.values.insert(self.next, metadata);
            allocated = Some(self.next);
            self.next
        });
        Ok((UndoContext { tag, positions }, allocated))
    }

    pub(super) fn discard(&mut self, allocated: Option<u64>) {
        if let Some(tag) = allocated {
            self.values.remove(&tag);
        }
    }

    pub(super) fn restored(&self, text: &str, context: &UndoContext) -> Result<Value, BufferError> {
        let positions = context
            .positions
            .iter()
            .map(|&position| byte_to_utf16(text, position))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({
            "metadata": context.tag.and_then(|tag| self.values.get(&tag)),
            "positions": positions,
        }))
    }
}

pub(super) fn edits(
    text: &str,
    edits: Vec<WireEdit>,
) -> Result<Vec<(std::ops::Range<usize>, String)>, BufferError> {
    edits
        .into_iter()
        .map(|edit| {
            Ok((
                utf16_to_byte(text, edit.from)?..utf16_to_byte(text, edit.to)?,
                edit.insert,
            ))
        })
        .collect()
}

pub(super) fn validate_base(current: &Version, base: &Version) -> Result<(), BufferError> {
    if current.identity() != base.identity() {
        Err(BufferError::IdentityMismatch)
    } else if current != base {
        Err(BufferError::StaleVersion)
    } else {
        Ok(())
    }
}

pub(super) fn encode_update(
    contexts: &Contexts,
    update: &BufferUpdate,
    before: &str,
    after: &TextSnapshot,
    undo: &UndoState,
    pending: bool,
) -> Result<Value, BufferError> {
    let edits = update
        .edits
        .iter()
        .map(|edit| {
            Ok(json!({
                "from": byte_to_utf16(before, edit.from)?,
                "to": byte_to_utf16(before, edit.to)?,
                "insert": edit.insert,
            }))
        })
        .collect::<Result<Vec<_>, BufferError>>()?;
    let restored = update
        .restored
        .as_ref()
        .map(|context| contexts.restored(&after.text, context))
        .transpose()?;
    let kind = match update.cause {
        ChangeCause::Local => "local",
        ChangeCause::Import => "import",
        ChangeCause::Undo => "undo",
        ChangeCause::Redo => "redo",
        ChangeCause::HistoryCleared => "history_cleared",
    };
    Ok(json!({
        "cause": {"kind": kind},
        "changed": update.changed,
        "before": update.before,
        "after": update.after,
        "beforeLen": byte_to_utf16(before, update.before_len)?,
        "afterLen": byte_to_utf16(&after.text, update.after_len)?,
        "stateRevision": after.state_revision,
        "edits": edits,
        "undo": undo,
        "restored": restored,
        "operation": update.operation,
        "pending": pending,
    }))
}

#[derive(Default)]
pub struct BufferAdapter {
    contexts: Contexts,
}

impl BufferAdapter {
    pub fn apply(&mut self, buffer: &mut Buffer, value: Value) -> Result<Value, BufferError> {
        let command: Command =
            serde_json::from_value(value).map_err(|error| BufferError::Crdt {
                message: error.to_string(),
            })?;
        let redo = matches!(&command, Command::Redo { .. });
        let before = buffer.snapshot();
        self.contexts.reserve(buffer.undo_tags());
        let mut allocated = None;
        let mut reset = false;
        let result = match command {
            Command::Edit {
                base,
                input,
                group,
                undo,
            } => {
                validate_base(&before.version, &base)?;
                // Convert the complete input before registering metadata.
                let input = match input {
                    Input::Edits { edits: script } => Ok(edits(&before.text, script)?),
                    Input::Text { text } => Err(text),
                };
                let (undo, tag) = self.contexts.context(&before.text, undo)?;
                allocated = tag;
                let options = EditOptions { group, undo };
                match input {
                    Ok(script) => buffer.edit_with(script, options),
                    Err(text) => buffer.replace_text_with(&text, options),
                }
            }
            Command::Undo { base, context } | Command::Redo { base, context } => {
                validate_base(&before.version, &base)?;
                let (context, tag) = self.contexts.context(&before.text, context)?;
                allocated = tag;
                if redo {
                    buffer.redo_with(context)
                } else {
                    buffer.undo_with(context)
                }
            }
            Command::Import { packet, reset_undo } => {
                reset = reset_undo;
                buffer.import_with(packet, ImportOptions { reset_undo })
            }
            Command::ClearUndo => {
                reset = true;
                buffer.clear_undo()
            }
        };
        if !result.as_ref().is_ok_and(|update| update.changed) {
            self.contexts.discard(allocated);
        }
        let update = result?;
        let encoded = encode_update(
            &self.contexts,
            &update,
            &before.text,
            &buffer.snapshot(),
            &buffer.undo_state(),
            buffer.has_pending_imports(),
        )?;
        drop(update);
        if reset {
            self.contexts.clear();
        } else {
            self.contexts.prune(buffer.undo_tags());
        }
        Ok(encoded)
    }
}
