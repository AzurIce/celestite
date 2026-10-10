//! External wire codecs and adapters. Native owners use byte coordinates.
pub mod buffer;
pub mod editor;
use celestite_buffer::types::BufferError;

pub fn byte_to_utf16(text: &str, offset: usize) -> Result<usize, BufferError> {
    if !text.is_char_boundary(offset) {
        return Err(BufferError::InvalidPosition { offset });
    }
    Ok(text[..offset].encode_utf16().count())
}
