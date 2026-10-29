//! Shared, host-independent Celestite editing kernel.
pub mod editor;
pub mod error;
pub mod fs;
pub mod instance;
#[cfg(feature = "language")]
pub mod language;
pub mod preview;
pub mod protocol;
pub mod source;
pub mod text;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;
