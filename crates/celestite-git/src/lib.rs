//! Read-only Git status observation for a hosted Vault.
//!
//! The host shells out to the user's Git binary so worktrees, submodules,
//! ignore rules and repository configuration behave exactly as they do in the
//! terminal. This module never stages, writes the index, or mutates files.
use celestite_core::protocol::git::{GitChange, GitStatusEntry, GitStatusSnapshot};
use std::{
    io,
    path::Path,
    process::{Command, Output},
};

/// Keep one status response bounded even when the repository is enormous.
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git is not installed")]
    Missing,
    #[error("could not run git: {0}")]
    Spawn(String),
    #[error("git command failed: {0}")]
    Command(String),
    #[error("git returned invalid status output")]
    InvalidOutput,
}

/// Discover the repository containing `vault_root` and scan its worktree.
///
/// `Ok(None)` means the directory is not inside a Git worktree, or Git is not
/// available. The caller may hide all Git decoration in that case.
pub fn inspect(vault_root: &Path) -> Result<Option<GitStatusSnapshot>, GitError> {
    let Some(prefix) = repository_prefix(vault_root)? else {
        return Ok(None);
    };
    let output = run_status(vault_root)?;
    if !output.status.success() {
        return Err(GitError::Command(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    let (entries, truncated) = parse_porcelain(&output.stdout, &prefix)?;
    Ok(Some(GitStatusSnapshot {
        branch: current_branch(vault_root),
        entries,
        truncated,
    }))
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(root);
    // Status is an observation. Do not refresh or rewrite the index, and do
    // not let a transient status scan invalidate the host's own file watcher.
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command.env("GIT_TERMINAL_PROMPT", "0");
    // A stale terminal environment must not point the observer at another repo.
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(name);
    }
    command
}

fn run(root: &Path, args: &[&str]) -> Result<Output, GitError> {
    git_command(root)
        .args(args)
        .output()
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => GitError::Missing,
            _ => GitError::Spawn(error.to_string()),
        })
}

/// Return the Vault root's path relative to the repository root, ending in `/`.
/// An empty string means the Vault is the repository root.
fn repository_prefix(root: &Path) -> Result<Option<String>, GitError> {
    let output = match run(
        root,
        &["rev-parse", "--is-inside-work-tree", "--show-prefix"],
    ) {
        Ok(output) => output,
        Err(GitError::Missing) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !output.status.success() {
        // Not a worktree is the common case. Permission and ownership errors
        // also mean status is unavailable, not that the Vault is broken.
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.split('\n');
    let inside = lines.next().unwrap_or("").trim();
    if inside != "true" {
        return Ok(None);
    }
    let prefix = lines.next().unwrap_or("").trim_end_matches('\r');
    Ok(Some(prefix.to_owned()))
}

fn current_branch(root: &Path) -> Option<String> {
    let output = run(root, &["symbolic-ref", "--short", "HEAD"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!branch.is_empty()).then_some(branch)
}

fn run_status(root: &Path) -> Result<Output, GitError> {
    run(
        root,
        &[
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--no-renames",
            "-z",
            "--",
            ".",
        ],
    )
}

/// Parse NUL-delimited `git status --porcelain=v1 --no-renames` output.
///
/// Records are `XY <path>`, where `<path>` is relative to the repository root.
/// Entries outside `vault_prefix` are discarded.
pub fn parse_porcelain(
    output: &[u8],
    vault_prefix: &str,
) -> Result<(Vec<GitStatusEntry>, bool), GitError> {
    let mut entries = Vec::new();
    let mut truncated = false;
    for record in output.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        if entries.len() > MAX_ENTRIES {
            truncated = true;
            break;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err(GitError::InvalidOutput);
        }
        let Ok(path) = std::str::from_utf8(&record[3..]) else {
            continue;
        };
        let path = if vault_prefix.is_empty() {
            path
        } else {
            let Some(path) = path.strip_prefix(vault_prefix) else {
                continue;
            };
            path
        };
        if path.is_empty() {
            continue;
        }
        let Some(entry) = entry(record[0], record[1], path) else {
            continue;
        };
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    if entries.len() > MAX_ENTRIES {
        entries.truncate(MAX_ENTRIES);
        truncated = true;
    }
    Ok((entries, truncated))
}

fn entry(x: u8, y: u8, path: &str) -> Option<GitStatusEntry> {
    if (x, y) == (b'?', b'?') {
        return Some(GitStatusEntry {
            path: path.to_owned(),
            index: GitChange::Unmodified,
            worktree: GitChange::Unmodified,
            untracked: true,
            conflict: false,
        });
    }
    let conflict = matches!(
        (x, y),
        (b'D', b'D')
            | (b'A', b'U')
            | (b'U', b'D')
            | (b'U', b'A')
            | (b'D', b'U')
            | (b'A', b'A')
            | (b'U', b'U')
    );
    Some(GitStatusEntry {
        path: path.to_owned(),
        index: change(x, false)?,
        worktree: change(y, true)?,
        untracked: false,
        conflict,
    })
}

fn change(byte: u8, worktree: bool) -> Option<GitChange> {
    Some(match byte {
        b' ' => GitChange::Unmodified,
        b'M' => GitChange::Modified,
        b'T' => GitChange::TypeChanged,
        b'A' => GitChange::Added,
        b'D' => GitChange::Deleted,
        b'R' => GitChange::Renamed,
        b'C' => GitChange::Copied,
        b'U' => GitChange::Unmerged,
        // Submodules can report modified content or untracked content with
        // lowercase markers. The file tree treats both as a worktree change.
        b'm' => GitChange::Modified,
        b'?' if worktree => GitChange::Modified,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command as ProcessCommand,
    };

    fn git(root: &Path, args: &[&str]) -> bool {
        ProcessCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn repo() -> Option<(tempfile::TempDir, PathBuf)> {
        if !ProcessCommand::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
        {
            return None;
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_owned();
        assert!(git(&root, &["init", "-q"]));
        assert!(git(&root, &["config", "user.email", "test@example.com"]));
        assert!(git(&root, &["config", "user.name", "Test"]));
        fs::write(root.join("a.md"), "base\n").unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/b.md"), "base\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-qm", "base"]));
        Some((directory, root))
    }

    #[test]
    fn parses_tracked_untracked_and_conflicted_records() {
        let (entries, truncated) = parse_porcelain(
            b" M a.md\0?? new file.md\0UU conflict.md\0 M web/a.md\0",
            "web/",
        )
        .unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "a.md");
        assert_eq!(entries[0].worktree, GitChange::Modified);
        assert!(!entries[0].untracked);

        let (entries, _) = parse_porcelain(b"?? new file.md\0", "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "new file.md");
        assert!(entries[0].untracked);

        let (entries, _) = parse_porcelain(b"UU conflict.md\0", "").unwrap();
        assert!(entries[0].conflict);
        assert_eq!(entries[0].index, GitChange::Unmerged);
        assert_eq!(entries[0].worktree, GitChange::Unmerged);
    }

    #[test]
    fn scans_a_repository_and_scopes_it_to_the_vault() {
        let Some((_directory, root)) = repo() else {
            return;
        };
        fs::write(root.join("a.md"), "changed\n").unwrap();
        fs::write(root.join("new.md"), "new\n").unwrap();
        let snapshot = inspect(&root).unwrap().unwrap();
        assert!(
            snapshot
                .branch
                .as_deref()
                .is_some_and(|branch| !branch.is_empty())
        );
        assert!(
            snapshot
                .entries
                .iter()
                .any(|entry| { entry.path == "a.md" && entry.worktree == GitChange::Modified })
        );
        assert!(
            snapshot
                .entries
                .iter()
                .any(|entry| entry.path == "new.md" && entry.untracked)
        );

        let nested = root.join("nested");
        fs::write(nested.join("b.md"), "changed\n").unwrap();
        let snapshot = inspect(&nested).unwrap().unwrap();
        assert!(!snapshot.entries.iter().any(|entry| entry.path == "a.md"));
        assert!(
            snapshot
                .entries
                .iter()
                .any(|entry| entry.path == "b.md" && entry.worktree == GitChange::Modified)
        );
    }

    #[test]
    fn a_non_repository_directory_has_no_status() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(inspect(directory.path()).unwrap(), None);
    }
}
