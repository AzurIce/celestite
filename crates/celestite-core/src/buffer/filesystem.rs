//! Fixed line Myers alignment followed by Unicode scalar Myers in changed regions.
//! Only the completed script is applied to an isolated historical branch.
use super::*;
use similar::{Algorithm, DiffTag, capture_diff_slices_deadline};
use std::time::Duration;
use web_time::Instant;

pub(crate) const DIFF_BUDGET: Duration = Duration::from_secs(5);

pub(crate) struct FilesystemChange {
    branch: Buffer,
    base: Version,
    expected: String,
}

impl FilesystemChange {
    pub(crate) fn new(branch: Buffer, base: Version, expected: String) -> Self {
        Self {
            branch,
            base,
            expected,
        }
    }

    pub(crate) fn compute(
        mut self,
        new_text: &str,
        budget: Duration,
    ) -> Result<(Option<SyncPacket>, Version), CoreError> {
        let deadline = Instant::now() + budget;
        let edits = difference(&self.expected, new_text, deadline)?;
        check_deadline(deadline)?;
        // This is a detached Buffer, not another implementation of CRDT editing.
        // A timeout discards the whole branch; the live Buffer is never touched.
        let mut edit = Edit::new(self.base.clone(), edits);
        edit.origin = "filesystem".into();
        let update = self.branch.apply(BufferCommand::Edit(edit))?;
        check_deadline(deadline)?;
        Ok((update.operation, update.after))
    }
}

fn check_deadline(deadline: Instant) -> Result<(), CoreError> {
    if Instant::now() >= deadline {
        Err(CoreError::FilesystemDiffTimeout)
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

fn difference(old: &str, new: &str, deadline: Instant) -> Result<Vec<TextEdit>, CoreError> {
    check_deadline(deadline)?;
    let old_lines: Vec<_> = old.split_inclusive('\n').collect();
    let new_lines: Vec<_> = new.split_inclusive('\n').collect();
    let old_bytes = offsets(&old_lines, |line| line.len());
    let new_bytes = offsets(&new_lines, |line| line.len());
    let old_utf16 = offsets(&old_lines, |line| line.encode_utf16().count());
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
        let positions = offsets(&before, |ch| ch.len_utf16());
        let scalars =
            capture_diff_slices_deadline(Algorithm::Myers, &before, &after, Some(deadline));
        check_deadline(deadline)?;
        for op in scalars {
            let (tag, a_chars, b_chars) = op.as_tag_tuple();
            if tag == DiffTag::Equal {
                continue;
            }
            let edit = TextEdit {
                from: old_utf16[a.start] + positions[a_chars.start],
                to: old_utf16[a.start] + positions[a_chars.end],
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
    use super::*;

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
                let edits = difference(old, new, Instant::now() + DIFF_BUDGET).unwrap();
                validate_edits(old, &edits).unwrap();
                let mut actual = old.to_string();
                for edit in edits.into_iter().rev() {
                    let from = utf16_to_byte(&actual, edit.from).unwrap();
                    let to = utf16_to_byte(&actual, edit.to).unwrap();
                    actual.replace_range(from..to, &edit.insert);
                }
                assert_eq!(actual, new, "old={old:?}");
            }
        }
    }

    #[test]
    fn expired_deadline_rejects_instead_of_accepting_a_coarse_script() {
        assert!(matches!(
            difference("old", "new", Instant::now()),
            Err(CoreError::FilesystemDiffTimeout)
        ));
    }
}
