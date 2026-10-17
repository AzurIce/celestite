//! Vault-relative path and LF text validation shared by every platform adapter.
use super::MAX_TEXT_BYTES;
use crate::backend::{DocumentHeader, EditorError, EditorResult, ErrorCode};
use crate::text::{DecodedText, LineEnding};

pub fn validate_editor_path(path: &str) -> EditorResult<()> {
    if path.contains(['\\', '\0'])
        || path.starts_with('/')
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
        || (!path.is_empty()
            && path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".."))
    {
        return Err(EditorError::new(
            ErrorCode::InvalidPath,
            "Expected a Vault-relative path",
            path,
        ));
    }
    Ok(())
}
pub(crate) fn within(path: &str, root: &str) -> bool {
    root.is_empty()
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('/'))
}
pub(crate) fn validate_text(text: &str, path: &str) -> EditorResult<()> {
    if text.chars().any(|c| c < ' ' && !matches!(c, '\n' | '\t')) {
        return Err(EditorError::new(
            ErrorCode::InvalidEdit,
            "Text uses LF; binary control characters are not accepted",
            path,
        ));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(EditorError::new(
            ErrorCode::Unsupported,
            "Text exceeds 5 MiB",
            path,
        ));
    }
    Ok(())
}
pub(crate) fn decode(bytes: &[u8], path: &str) -> EditorResult<DecodedText> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(EditorError::new(
            ErrorCode::Unsupported,
            "Text exceeds 5 MiB",
            path,
        ));
    }
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let raw = std::str::from_utf8(if bom { &bytes[3..] } else { bytes })
        .map_err(|_| EditorError::new(ErrorCode::Unsupported, "Not a UTF-8 text file", path))?;
    if raw
        .chars()
        .any(|c| c < ' ' && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(EditorError::new(
            ErrorCode::Unsupported,
            "Not an editable text file",
            path,
        ));
    }
    Ok(DecodedText {
        text: raw.replace("\r\n", "\n").replace('\r', "\n"),
        bom,
        line_ending: LineEnding::detect(raw),
    })
}
pub(crate) fn encode(header: &DocumentHeader, text: &str) -> Vec<u8> {
    format!(
        "{}{}",
        if header.bom { "\u{feff}" } else { "" },
        header.line_ending.restore(text)
    )
    .into_bytes()
}
