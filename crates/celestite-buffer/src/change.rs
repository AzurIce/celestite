//! Fixed line Myers alignment followed by Unicode scalar Myers in changed regions.
//! Only the completed script is applied to an isolated historical branch.
use crate::{
    Buffer,
    types::{BufferError, HistoryPacket, TextEdit, Version},
};
use similar::{Algorithm, DiffTag, capture_diff_slices_deadline};
use std::time::Duration;
use web_time::Instant;

/// A single-use isolated rewrite prepared by `Buffer::prepare_text_change`.
pub struct TextChangeTask {
    branch: Buffer,
    base: Version,
    expected: String,
}

impl TextChangeTask {
    pub(crate) fn new(branch: Buffer, base: Version, expected: String) -> Self {
        Self {
            branch,
            base,
            expected,
        }
    }

    /// Compute with a caller-owned budget. A timeout discards the isolated branch.
    /// The returned packet must be imported explicitly into the live Buffer.
    pub fn compute(
        mut self,
        new_text: &str,
        budget: Duration,
    ) -> Result<(Option<HistoryPacket>, Version), BufferError> {
        let deadline = Instant::now() + budget;
        let edits = difference(&self.expected, new_text, deadline)?;
        check_deadline(deadline)?;
        // This is a detached Buffer, not another implementation of CRDT editing.
        // A timeout discards the whole branch; the live Buffer is never touched.
        debug_assert_eq!(self.branch.version(), self.base);
        let update = self.branch.edit(
            edits
                .into_iter()
                .map(|edit| (edit.from..edit.to, edit.insert)),
        )?;
        check_deadline(deadline)?;
        Ok((update.operation, update.after))
    }
}

fn check_deadline(deadline: Instant) -> Result<(), BufferError> {
    if Instant::now() >= deadline {
        Err(BufferError::DiffTimeout)
    } else {
        Ok(())
    }
}

fn offsets<T>(values: &[T], width: impl Fn(&T) -> usize) -> Vec<usize> {
    std::iter::once(0)
        .chain(values.iter().scan(0, |offset, value| {
            *offset += width(value);
            Some(*offset)
        }))
        .collect()
}

fn difference(old: &str, new: &str, deadline: Instant) -> Result<Vec<TextEdit>, BufferError> {
    check_deadline(deadline)?;
    let old_lines: Vec<_> = old.split_inclusive('\n').collect();
    let new_lines: Vec<_> = new.split_inclusive('\n').collect();
    let old_bytes = offsets(&old_lines, |line| line.len());
    let new_bytes = offsets(&new_lines, |line| line.len());
    // The pinned algorithm also fixes tie-breaking between repeated characters.
    let lines =
        capture_diff_slices_deadline(Algorithm::Myers, &old_lines, &new_lines, Some(deadline));
    // Similar may return a coarse script on deadline. Never accept that script:
    // timing controls rejection only, not the accepted edits or character identity.
    check_deadline(deadline)?;
    let mut edits: Vec<TextEdit> = vec![];
    for op in lines {
        let (tag, a, b) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        let before: Vec<char> = old[old_bytes[a.start]..old_bytes[a.end]].chars().collect();
        let after: Vec<char> = new[new_bytes[b.start]..new_bytes[b.end]].chars().collect();
        let positions = offsets(&before, |ch| ch.len_utf8());
        let scalars =
            capture_diff_slices_deadline(Algorithm::Myers, &before, &after, Some(deadline));
        check_deadline(deadline)?;
        for op in scalars {
            let (tag, a_chars, b_chars) = op.as_tag_tuple();
            if tag == DiffTag::Equal {
                continue;
            }
            let edit = TextEdit {
                from: old_bytes[a.start] + positions[a_chars.start],
                to: old_bytes[a.start] + positions[a_chars.end],
                insert: after[b_chars].iter().collect(),
            };
            // Adjacent line hunks can put an insertion and deletion at one gap.
            if let Some(previous) = edits.last_mut()
                && previous.to == edit.from
            {
                previous.to = edit.to;
                previous.insert.push_str(&edit.insert);
            } else {
                edits.push(edit);
            }
        }
    }
    check_deadline(deadline)?;
    Ok(edits)
}

#[cfg(test)]
mod tests {
    use super::difference;
    use crate::{
        Buffer, text,
        types::{BufferError, DocumentIdentity, TextEdit},
    };
    use std::time::Duration;
    use web_time::Instant;

    #[test]
    fn unicode_repeated_lines_and_line_boundaries_reconstruct_exact_text() {
        let inputs = [
            "",
            "\n",
            "same\nsame\n",
            "😀e\u{301}\n中\n",
            "A middle B",
            "A1 middle B1",
            "tail",
            "tail\n",
        ];
        for old in inputs {
            for new in inputs {
                let edits = difference(old, new, Instant::now() + Duration::from_secs(5)).unwrap();
                text::validate_edits(old, &edits).unwrap();
                let mut actual = old.to_string();
                for edit in edits.into_iter().rev() {
                    actual.replace_range(edit.from..edit.to, &edit.insert);
                }
                assert_eq!(actual, new, "old={old:?}");
            }
        }
    }

    #[test]
    fn repeated_characters_preserve_the_pinned_alignment_and_original_anchors() {
        // Generated once with an LCG and a deterministic delete/insert pattern.
        // Both exact and heuristic Myers in similar 3.2 delete the first of
        // OLD[65..67]'s adjacent `u`s. The original 2.7 contract deletes the
        // second; equal final strings are not sufficient for CRDT compatibility.
        const OLD: &str = "npgjeuyyihFFlrCzAwjmfxueepviejxBEaByiogutfweeFzndBEqwjDExgpgyivuquuDAnpDpbxpziuzCivfpkncabpsrksjdqBBdkciezoqsldopenjwdcxhdzttggr";
        const NEW: &str = "apgjeuyyihFlrCzAwjmfxeepviejxBEByiofgutfweFzndBEqwjDxgpgyivuquDAnpDpbxkpzuzCivfpkncbpsrksjdqBdkciezoqsloppenjwdcxhzttggr";
        let expected = [
            (0..1, "a"),
            (11..12, ""),
            (22..23, ""),
            (33..34, ""),
            (38..38, "f"),
            (44..45, ""),
            (55..56, ""),
            (66..67, ""),
            (75..75, "k"),
            (77..78, ""),
            (88..89, ""),
            (99..100, ""),
            (110..111, ""),
            (113..113, "p"),
            (121..122, ""),
        ]
        .into_iter()
        .map(|(range, insert)| TextEdit {
            from: range.start,
            to: range.end,
            insert: insert.into(),
        })
        .collect::<Vec<_>>();
        assert_eq!(
            difference(OLD, NEW, Instant::now() + Duration::from_secs(5)).unwrap(),
            expected,
        );

        let mut buffer = Buffer::new(
            DocumentIdentity {
                document_id: "alignment".into(),
                history_id: "history".into(),
            },
            OLD,
        )
        .unwrap();
        let retained = buffer.anchor_after(65).unwrap();
        let deleted = buffer.anchor_after(66).unwrap();
        let following = buffer.anchor_after(67).unwrap();
        let (packet, version) = buffer
            .prepare_text_change(&buffer.version(), OLD)
            .unwrap()
            .compute(NEW, Duration::from_secs(5))
            .unwrap();
        let update = buffer.import(packet.unwrap()).unwrap();
        assert_eq!(update.edits, expected);
        assert!(update.local_operation().is_none());
        assert_eq!(buffer.text(), NEW);
        assert_eq!(buffer.historical_text(&version).unwrap(), NEW);
        assert_eq!(retained.to_offset(&buffer).unwrap(), 61);
        assert_eq!(deleted.to_offset(&buffer).unwrap(), 62);
        assert_eq!(following.to_offset(&buffer).unwrap(), 62);
    }

    #[test]
    fn expired_deadline_rejects_instead_of_accepting_a_coarse_script() {
        assert!(matches!(
            difference("old", "new", Instant::now()),
            Err(BufferError::DiffTimeout)
        ));
    }
}
