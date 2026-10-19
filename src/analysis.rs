//! Native work cannot be forcibly interrupted; bound abandoned analysis too.
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use std::sync::atomic::{AtomicUsize, Ordering};

static RUNNING: AtomicUsize = AtomicUsize::new(0);

struct Slot;
impl Drop for Slot {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn run<T>(work: impl FnOnce() -> T) -> EditorResult<T> {
    RUNNING
        .try_update(Ordering::AcqRel, Ordering::Acquire, |running| {
            (running < 2).then_some(running + 1)
        })
        .map_err(|_| EditorError::new(ErrorCode::Busy, "原生预览计算仍在运行，请稍后重试。", ""))?;
    let _slot = Slot;
    Ok(work())
}
