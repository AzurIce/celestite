//! Physical text encoding shared by file projection and serialized views.
//! Editing history always stores LF; line endings are restored only at file boundaries.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineEnding {
    #[default]
    #[serde(rename = "\n")]
    Lf,
    #[serde(rename = "\r\n")]
    CrLf,
    #[serde(rename = "\r")]
    Cr,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::CrLf => "\r\n",
            Self::Cr => "\r",
        }
    }

    /// The first physical ending in the file wins; LF when the text has no line break.
    pub fn detect(text: &str) -> Self {
        match text.find(['\r', '\n']) {
            Some(index) if text[index..].starts_with("\r\n") => Self::CrLf,
            Some(index) if text[index..].starts_with('\r') => Self::Cr,
            _ => Self::Lf,
        }
    }

    pub fn restore(self, text: &str) -> String {
        text.replace('\n', self.as_str())
    }
}

/// A decoded text file: normalized LF text plus the physical format needed to write it back.
#[derive(Debug, Clone)]
pub struct DecodedText {
    pub text: String,
    pub bom: bool,
    pub line_ending: LineEnding,
}

#[cfg(test)]
mod tests {
    use super::LineEnding;

    #[test]
    fn physical_line_endings_round_trip_and_accept_legacy_strings() {
        for (ending, wire) in [
            (LineEnding::Lf, "\"\\n\""),
            (LineEnding::CrLf, "\"\\r\\n\""),
            (LineEnding::Cr, "\"\\r\""),
        ] {
            assert_eq!(serde_json::from_str::<LineEnding>(wire).unwrap(), ending);
            assert_eq!(serde_json::to_string(&ending).unwrap(), wire);
        }
    }

    #[test]
    fn detection_uses_the_first_physical_break() {
        assert_eq!(LineEnding::detect("one\ntwo\r\nthree"), LineEnding::Lf);
        assert_eq!(LineEnding::detect("one\r\ntwo\nthree"), LineEnding::CrLf);
        assert_eq!(LineEnding::detect("one\rtwo\r\nthree"), LineEnding::Cr);
        assert_eq!(LineEnding::detect("no breaks"), LineEnding::Lf);
        assert_eq!(LineEnding::CrLf.restore("a\nb"), "a\r\nb");
    }
}
