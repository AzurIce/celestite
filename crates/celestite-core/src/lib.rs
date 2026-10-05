//! Shared, host-independent Celestite editing kernel.
pub mod document;
pub use document::*;
pub mod instance;
pub use instance::*;
pub mod backend;
pub mod editor;
pub use backend::*;
pub use editor::*;
pub mod memory;
pub use memory::MemoryBackend;
pub mod preview;
pub use preview::*;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod browser;
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;
