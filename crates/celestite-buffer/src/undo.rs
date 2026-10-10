//! One peer's undo session. Hook payloads are local editor context, not CRDT state.
use crate::types::{BufferError, UndoState, crdt_error};
use loro::{
    LoroDoc, UndoItemMeta, UndoManager,
    cursor::{Cursor, Side},
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};

#[derive(Default)]
pub(super) struct Restoration {
    pub tag: Option<u64>,
    pub frame: Option<Arc<Vec<u8>>>,
    /// Unicode scalar positions, resolved against the text AFTER undo/redo.
    pub positions: Vec<usize>,
}

#[derive(Default)]
struct Context {
    tag: Option<u64>,
    cursors: Vec<Cursor>,
    restored: Restoration,
    frames: BTreeMap<u64, Vec<Weak<Vec<u8>>>>,
}

impl Context {
    fn prune_frames(&mut self) {
        self.frames.retain(|_, frames| {
            frames.retain(|frame| frame.strong_count() != 0);
            !frames.is_empty()
        });
    }
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
            let mut context = push.lock().unwrap();
            // Do not accumulate dead weak entries when a native owner never
            // queries tags. Lifetime still comes solely from Loro and receipts.
            context.prune_frames();
            let mut meta = UndoItemMeta::new();
            if let Some(tag) = context.tag {
                let value = loro::LoroValue::Binary(tag.to_le_bytes().to_vec().into());
                let frame = Arc::<Vec<u8>>::try_from(value.clone()).expect("binary tag frame");
                let frames = context.frames.entry(tag).or_default();
                frames.retain(|frame| frame.strong_count() != 0);
                frames.push(Arc::downgrade(&frame));
                meta.set_value(value);
            }
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
            context.restored.frame = Arc::<Vec<u8>>::try_from(meta.value).ok();
            context.restored.tag = context
                .restored
                .frame
                .as_ref()
                .and_then(|frame| frame.as_slice().try_into().ok())
                .map(u64::from_le_bytes);
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

    /// Loro's metadata owns the frames. This weak registry never decides stack
    /// transitions, grouping or pruning; queued receipts own restored frames too.
    pub(super) fn tags(&self) -> Vec<u64> {
        let mut context = self.context.lock().unwrap();
        context.prune_frames();
        context.frames.keys().copied().collect()
    }

    pub(super) fn prepare(&mut self, tag: Option<u64>, cursors: Vec<Cursor>) {
        let mut context = self.context.lock().unwrap();
        context.tag = tag;
        context.cursors = cursors;
    }

    pub(super) fn record(&mut self, group: Option<String>, tag: Option<u64>, cursors: Vec<Cursor>) {
        if group.is_none() || self.group != group {
            self.end_group();
            if group.is_some() {
                self.manager
                    .group_start()
                    .expect("new undo group after ending the previous one");
            }
            self.group = group;
        }
        self.prepare(tag, cursors);
    }

    pub(super) fn end_group(&mut self) {
        self.manager.group_end();
        self.group = None;
    }

    pub(super) fn clear(&mut self) {
        self.end_group();
        self.manager.clear();
        let mut context = self.context.lock().unwrap();
        context.tag = None;
        context.cursors.clear();
        context.restored = Restoration::default();
    }

    pub(super) fn apply(&mut self, redo: bool) -> Result<bool, BufferError> {
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
