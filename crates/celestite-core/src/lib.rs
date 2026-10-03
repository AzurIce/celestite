//! Shared, host-independent Celestite editing kernel.
pub mod document;
pub use document::*;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;
