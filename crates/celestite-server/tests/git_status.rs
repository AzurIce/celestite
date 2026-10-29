//! Git status is read-only decoration: it follows the host directory, scopes
//! paths to the Vault, and remains available through a readonly link.
mod support;
use serde_json::Value;
use std::{path::Path, process::Command};

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
}
fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn returns_scoped_status_for_edit_and_readonly_links() {
    if !git_available() {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "test@example.com"]);
    git(root, &["config", "user.name", "Test"]);
    std::fs::write(root.join("a.md"), "base\n").unwrap();
    git(root, &["add", "a.md"]);
    git(root, &["commit", "-qm", "base"]);
    std::fs::write(root.join("a.md"), "changed\n").unwrap();
    std::fs::write(root.join("new.md"), "new\n").unwrap();

    let host = support::Host::start(root, false).await;
    let status = host.json("GET", "/git/status", Value::Null).await;
    let entries = status["entries"].as_array().unwrap();
    assert!(entries
        .iter()
        .any(|entry| { entry["path"] == "a.md" && entry["worktree"] == "modified" }));
    assert!(entries
        .iter()
        .any(|entry| entry["path"] == "new.md" && entry["untracked"] == true));

    let readonly = host
        .client
        .get(format!("{}/git/status", host.readonly_url))
        .send()
        .await
        .unwrap();
    assert!(readonly.status().is_success());
    let readonly: Value = readonly.json().await.unwrap();
    assert_eq!(readonly["entries"].as_array().unwrap().len(), entries.len());

    let description = host.json("GET", "", Value::Null).await;
    assert_eq!(description["capabilities"]["gitStatus"], true);
    host.stop().await;
}

#[tokio::test]
async fn a_plain_directory_returns_null_instead_of_failing() {
    if !git_available() {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let host = support::Host::start(directory.path(), false).await;
    let status = host.json("GET", "/git/status", Value::Null).await;
    assert_eq!(status, Value::Null);
    host.stop().await;
}
