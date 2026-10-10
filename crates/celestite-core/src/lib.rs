//! Shared, host-independent Celestite editing kernel.
pub mod backend;
pub mod editor;
pub mod instance;
pub mod preview;
pub mod protocol;
pub mod source;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;
