//! Observe through the change feed before reading a document: a GET must not be
//! what causes these filesystem edits to enter host history.
mod support;
use reqwest::Response;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

struct Host {
    server: support::Host,
    client_replica: tokio::sync::Mutex<Option<support::ClientReplica>>,
}
impl std::ops::Deref for Host {
    type Target = support::Host;
    fn deref(&self) -> &Self::Target {
        &self.server
    }
}
impl Host {
    async fn start(root: &Path, read_only: bool) -> Self {
        Self {
            server: support::Host::start(root, read_only).await,
            client_replica: tokio::sync::Mutex::new(None),
        }
    }
    async fn request(&self, method: &str, path: &str, value: Value) -> Value {
        self.server.json(method, path, value).await
    }
    async fn mutate(&self, id: &str, edit: Option<(std::ops::Range<usize>, &str)>) -> Value {
        let mut slot = self.client_replica.lock().await;
        if slot.is_none() {
            *slot = Some(support::ClientReplica::connect(&self.url).await);
        }
        let client = slot.as_mut().unwrap();
        if client.core.read(id).is_err() {
            let state = self.state(id).await;
            assert_eq!(client.open(state["path"].as_str().unwrap()).await, id);
        } else {
            client.sync(id).await;
        }
        if let Some((range, text)) = edit {
            client.edit(id, range.start, range.end, text).await;
        } else {
            client.undo(id, false).await;
        }
        self.state(id).await
    }
    async fn save(&self, id: &str, version: Value) -> Value {
        let mut slot = self.client_replica.lock().await;
        let client = slot.as_mut().unwrap();
        let receipt = client.ok("save", json!({"id":id,"version":version})).await;
        client.accept(receipt).await;
        self.state(id).await
    }
    async fn feed(&self) -> Feed {
        let response = self
            .server
            .client
            .get(format!("{}/documents/events", self.url))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert_eq!(response.headers()["cache-control"], "no-store");
        Feed {
            response,
            pending: vec![],
        }
    }
    async fn state(&self, id: &str) -> Value {
        self.request("GET", &format!("/documents/{id}"), Value::Null)
            .await
    }
    async fn open(&self, path: &str) -> Value {
        self.request("POST", "/documents/open", json!({"path":path}))
            .await
    }
    async fn stop(self) {
        if let Some(client) = self.client_replica.into_inner() {
            client.close().await;
        }
        self.server.stop().await;
    }
}
struct Feed {
    response: Response,
    pending: Vec<u8>,
}
impl Feed {
    async fn next(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Some(end) = self.pending.windows(2).position(|b| b == b"\n\n") {
                    let frame = self.pending.drain(..end + 2).collect::<Vec<_>>();
                    let frame = std::str::from_utf8(&frame).unwrap();
                    if let Some(data) = frame.lines().find_map(|line| line.strip_prefix("data: ")) {
                        assert!(frame.lines().any(|line| line == "event: documents"));
                        return serde_json::from_str(data).unwrap();
                    }
                    continue;
                }
                self.pending
                    .extend_from_slice(&self.response.chunk().await.unwrap().expect("live stream"));
            }
        })
        .await
        .expect("background reconciliation notification")
    }
    async fn until(&mut self, id: &str, predicate: impl Fn(&Value) -> bool) -> Value {
        // A bounded overall deadline also prevents a noisy stream from hiding a lost edit.
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = self.next().await;
                if let Some(notice) = event["documents"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|notice| notice["id"] == id && predicate(notice))
                {
                    return notice.clone();
                }
            }
        })
        .await
        .unwrap()
    }
}
fn notice<'a>(event: &'a Value, path: &str) -> &'a Value {
    event["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|doc| doc["path"] == path)
        .unwrap()
}
async fn append(host: &Host, id: &str, state: &Value, text: &str) -> Value {
    let offset = state["snapshot"]["text"].as_str().unwrap().len();
    host.mutate(id, Some((offset..offset, text))).await
}

#[tokio::test]
async fn observation_updates_open_buffers_without_discovering_unopened_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("nested/a.md"), "base 😀").unwrap();
    std::fs::write(root.path().join("binary"), [0xff]).unwrap();
    let host = Host::start(root.path(), false).await;
    let mut feed = host.feed().await;
    let initial = feed.next().await;
    assert_eq!(initial["kind"], "resync");
    assert_eq!(initial["documents"], json!([]));
    let opened = host.open("nested/a.md").await;
    let id = opened["id"].as_str().unwrap().to_owned();
    let old = opened["snapshot"]["version"].clone();
    std::fs::write(root.path().join("nested/a.md"), "external base 😀").unwrap();
    let changed = feed.until(&id, |notice| notice["version"] != old).await;
    assert_eq!(changed["available"], true);
    assert_eq!(changed["version"], changed["savedVersion"]);
    let state = host.state(&id).await;
    assert_eq!(state["snapshot"]["text"], "external base 😀");
    assert!(state["durableVersion"].is_null());
    // A new file has never been opened or fetched by a client.
    std::fs::write(root.path().join("nested/new.md"), "new").unwrap();
    assert_eq!(
        host.request("GET", "/documents", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(host.open("nested/new.md").await["snapshot"]["text"], "new");
    drop(feed);
    host.stop().await;
}

#[tokio::test]
async fn consecutive_disk_edits_merge_with_dirty_history_and_saved_echo_does_not_edit_again() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A middle B").unwrap();
    let host = Host::start(root.path(), false).await;
    host.open("a.md").await;
    let mut feed = host.feed().await;
    let initial = feed.next().await;
    let id = notice(&initial, "a.md")["id"].as_str().unwrap().to_owned();
    let state = host.mutate(&id, Some((2..8, "MIDDLE"))).await;
    feed.until(&id, |notice| {
        notice["version"] == state["snapshot"]["version"]
    })
    .await;
    let peer_id = host.state(&id).await["writerId"].clone();
    let mut prior = state["snapshot"]["version"].clone();
    for text in ["A1 middle B1", "A2 middle B2", "A middle B"] {
        std::fs::write(root.path().join("a.md"), text).unwrap();
        let event = feed.until(&id, |notice| notice["version"] != prior).await;
        prior = event["version"].clone();
        let state = host.state(&id).await;
        assert_eq!(state["snapshot"]["text"], text.replace("middle", "MIDDLE"));
        assert_eq!(state["writerId"], peer_id);
        assert_eq!(state["conflict"], false);
    }
    let saved = host.save(&id, prior.clone()).await;
    feed.until(&id, |notice| notice["dirty"] == false).await;
    assert_eq!(saved["snapshot"]["version"], prior);
    // Rewriting the exact bytes generates OS events but no further CRDT operation.
    std::fs::write(root.path().join("a.md"), "A MIDDLE B").unwrap();
    tokio::time::sleep(Duration::from_millis(160)).await;
    assert_eq!(host.state(&id).await["snapshot"]["version"], prior);
    let undone = host.mutate(&id, None).await;
    assert_eq!(undone["snapshot"]["text"], "A middle B");
    drop(feed);
    host.stop().await;
}

#[tokio::test]
async fn invalid_content_and_external_deletion_do_not_starve_other_files_or_destroy_drafts() {
    let root = tempfile::tempdir().unwrap();
    for name in ["a.md", "b.md"] {
        std::fs::write(root.path().join(name), "base").unwrap();
    }
    let host = Host::start(root.path(), false).await;
    host.open("a.md").await;
    host.open("b.md").await;
    let mut feed = host.feed().await;
    let initial = feed.next().await;
    let a = notice(&initial, "a.md")["id"].as_str().unwrap().to_owned();
    let b = notice(&initial, "b.md")["id"].as_str().unwrap().to_owned();
    let state = append(&host, &a, &host.state(&a).await, " draft").await;
    feed.until(&a, |notice| notice["dirty"] == true).await;
    std::fs::write(root.path().join("a.md"), [0xff]).unwrap();
    std::fs::write(root.path().join("b.md"), "changed base").unwrap();
    // Both paths are in one scan; the invalid file must not abort discovery/refresh.
    let mut bad = false;
    let mut good = false;
    while !(bad && good) {
        let event = feed.next().await;
        for notice in event["documents"].as_array().unwrap() {
            bad |= notice["id"] == a && notice["conflict"] == true;
            good |= notice["id"] == b
                && notice["version"]
                    != initial["documents"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|n| n["id"] == b)
                        .unwrap()["version"];
        }
    }
    // Restore valid text first, then observe deletion as a separate snapshot.
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    feed.until(&a, |notice| notice["conflict"] == false).await;
    std::fs::remove_file(root.path().join("a.md")).unwrap();
    feed.until(&a, |notice| notice["conflict"] == true).await;
    let missing = host.state(&a).await;
    assert_eq!(missing["snapshot"], state["snapshot"]);
    assert_eq!(missing["deleted"], false);
    assert_eq!(host.state(&b).await["snapshot"]["text"], "changed base");
    drop(feed);
    host.stop().await;
}

#[tokio::test]
async fn a_read_only_vault_still_observes_its_hosts_external_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), true).await;
    host.open("a.md").await;
    let mut feed = host.feed().await;
    let initial = feed.next().await;
    let id = notice(&initial, "a.md")["id"].as_str().unwrap().to_owned();
    std::fs::write(root.path().join("a.md"), "external").unwrap();
    feed.until(&id, |current| {
        current["version"] != notice(&initial, "a.md")["version"]
    })
    .await;
    assert_eq!(host.state(&id).await["snapshot"]["text"], "external");
    drop(feed);
    host.stop().await;
}
