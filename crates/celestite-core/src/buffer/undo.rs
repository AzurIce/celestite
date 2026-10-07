//! One writer's undo session. Hook payloads are local editor context, not CRDT state.
use super::{CoreError, UndoState, crdt_error};
use loro::{
    LoroDoc, UndoItemMeta, UndoManager,
    cursor::{Cursor, Side},
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct Restoration {
    pub metadata: Option<Value>,
    /// Unicode scalar positions, resolved against the text AFTER undo/redo.
    pub positions: Vec<usize>,
}

#[derive(Default)]
struct Context {
    metadata: Option<Value>,
    cursors: Vec<Cursor>,
    restored: Restoration,
}

pub(super) struct UndoSession {
    manager: UndoManager,
    group: Option<String>,
    context: Arc<Mutex<Context>>,
}

impl UndoSession {
    pub(super) fn new(doc: &LoroDoc) -> Self {
        let context = Arc::new(Mutex::new(Context::default()));
        let mut manager = UndoManager::new(doc);
        manager.set_merge_interval(0);
        manager.set_max_undo_steps(500);
        let push = context.clone();
        manager.set_on_push(Some(Box::new(move |_, _, _| {
            let context = push.lock().unwrap();
            let mut meta = UndoItemMeta::new();
            meta.set_value(serde_json::to_string(&context.metadata).unwrap().into());
            for cursor in &context.cursors {
                meta.add_cursor(cursor);
            }
            meta
        })));
        let pop = context.clone();
        manager.set_on_pop(Some(Box::new(move |_, _, meta| {
            let mut context = pop.lock().unwrap();
            context.restored.positions = meta
                .cursors
                .iter()
                .map(|cursor| {
                    // Loro does not transform absolute end cursors. Resolve the
                    // sentinel against AFTER text rather than retaining its old size.
                    if cursor.cursor.id.is_none() && cursor.cursor.side == Side::Right {
                        usize::MAX
                    } else {
                        cursor.pos.pos
                    }
                })
                .collect();
            context.restored.metadata = match meta.value {
                loro::LoroValue::String(json) => {
                    serde_json::from_str::<Option<Value>>(json.as_str())
                        .ok()
                        .flatten()
                }
                _ => None,
            };
        })));
        Self {
            manager,
            group: None,
            context,
        }
    }

    pub(super) fn state(&self) -> UndoState {
        UndoState {
            can_undo: self.manager.can_undo(),
            can_redo: self.manager.can_redo(),
        }
    }

    pub(super) fn prepare(&mut self, metadata: Option<Value>, cursors: Vec<Cursor>) {
        let mut context = self.context.lock().unwrap();
        context.metadata = metadata;
        context.cursors = cursors;
    }

    pub(super) fn record(
        &mut self,
        group: Option<String>,
        metadata: Option<Value>,
        cursors: Vec<Cursor>,
    ) {
        if group.is_none() || self.group != group {
            self.end_group();
            if group.is_some() {
                self.manager
                    .group_start()
                    .expect("new undo group after ending the previous one");
            }
            self.group = group;
        }
        self.prepare(metadata, cursors);
    }

    pub(super) fn end_group(&mut self) {
        self.manager.group_end();
        self.group = None;
    }

    pub(super) fn clear(&mut self) {
        self.end_group();
        self.manager.clear();
    }

    pub(super) fn apply(&mut self, redo: bool) -> Result<bool, CoreError> {
        self.end_group();
        self.context.lock().unwrap().restored = Restoration::default();
        if redo {
            self.manager.redo()
        } else {
            self.manager.undo()
        }
        .map_err(crdt_error)
    }

    pub(super) fn take_restoration(&mut self) -> Restoration {
        std::mem::take(&mut self.context.lock().unwrap().restored)
    }
}
