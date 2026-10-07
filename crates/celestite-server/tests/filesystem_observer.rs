//! Observe through the change feed before reading a document: a GET must not be
//! what causes these filesystem edits to enter host history.
use celestite_server::{Config, HistoryMode, ServerConfig, VaultConfig, build_server};
use reqwest::{Client, Response};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};

struct Host {
    client: Client,
    url: String,
    shutdown: oneshot::Sender<()>,
    stopping: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Host {
    async fn start(root: &Path, state: &Path, read_only: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = build_server(
            Config {
                server: ServerConfig {
                    listen: address,
                    ..Default::default()
                },
                vault: VaultConfig {
                    name: "Notes".into(),
                    path: root.into(),
                    state_dir: Some(state.into()),
                    read_only,
                    history_mode: if state.join("history.redb").exists() {
                        HistoryMode::Recover
                    } else {
                        HistoryMode::Initialize
                    },
                    ..Default::default()
                },
            },
            root,
        )
        .unwrap();
        let key = server
            .links
            .key(celestite_server::Permission::Edit)
            .to_owned();
        let (shutdown, stopping) = oneshot::channel();
        let stop_events = server.shutdown;
        let task = tokio::spawn(async move {
            axum::serve(listener, server.router)
                .with_graceful_shutdown(async {
                    let _ = stopping.await;
                })
                .await
                .unwrap();
        });
        Self {
            client: Client::new(),
            url: format!("http://{address}/{key}/api/v1"),
            shutdown,
            stopping: stop_events,
            task,
        }
    }
    async fn request(&self, method: &str, path: &str, value: Value) -> Value {
        let response = self
            .client
            .request(method.parse().unwrap(), format!("{}{path}", self.url))
            .json(&value)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        serde_json::from_str(&body).unwrap()
    }
    async fn feed(&self) -> Feed {
        let response = self
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
    async fn stop(self) {
        self.stopping.send_replace(true);
        let _ = self.shutdown.send(());
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .unwrap()
            .unwrap();
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
    let offset = state["snapshot"]["text"]
        .as_str()
        .unwrap()
        .encode_utf16()
        .count();
    host.request("POST", &format!("/documents/{id}/apply"), json!({"kind":"edit","base":state["snapshot"]["version"],"origin":"test","input":{"kind":"edits","edits":[{"from":offset,"to":offset,"insert":text}]},"undo":{"metadata":null,"positions":[]}})).await["document"].clone()
}

#[tokio::test]
async fn unopened_files_are_discovered_and_external_changes_commit_before_notification() {
    let root = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("nested/a.md"), "base 😀").unwrap();
    std::fs::write(root.path().join("binary"), [0xff]).unwrap();
    let host = Host::start(root.path(), history.path(), false).await;
    let mut feed = host.feed().await;
    let initial = feed.next().await;
    assert_eq!(initial["kind"], "resync");
    assert_eq!(initial["documents"].as_array().unwrap().len(), 1);
    let id = notice(&initial, "nested/a.md")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let old = notice(&initial, "nested/a.md")["version"].clone();
    std::fs::write(root.path().join("nested/a.md"), "external base 😀").unwrap();
    let changed = feed.until(&id, |notice| notice["version"] != old).await;
    assert_eq!(changed["available"], true);
    assert_eq!(changed["version"], changed["savedVersion"]);
    let state = host.state(&id).await;
    assert_eq!(state["snapshot"]["text"], "external base 😀");
    assert_eq!(state["durableVersion"], changed["version"]);
    // A new file has never been opened or fetched by a client.
    std::fs::write(root.path().join("nested/new.md"), "new").unwrap();
    loop {
        let event = feed.next().await;
        if event["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["path"] == "nested/new.md")
        {
            break;
        }
    }
    drop(feed);
    host.stop().await;
    let host = Host::start(root.path(), history.path(), false).await;
    let mut feed = host.feed().await;
    let recovered = feed.next().await;
    assert_ne!(recovered["streamId"], initial["streamId"]);
    assert_eq!(recovered["vaultIdentity"], initial["vaultIdentity"]);
    assert_eq!(notice(&recovered, "nested/a.md")["id"], id);
    assert_eq!(
        notice(&recovered, "nested/a.md")["version"],
        changed["version"]
    );
    drop(feed);
    host.stop().await;
}

#[tokio::test]
async fn consecutive_disk_edits_merge_with_dirty_history_and_saved_echo_does_not_edit_again() {
    let root = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A middle B").unwrap();
    let host = Host::start(root.path(), history.path(), false).await;
    let mut feed = host.feed().await;
    let initial = feed.next().await;
    let id = notice(&initial, "a.md")["id"].as_str().unwrap().to_owned();
    let state = host.state(&id).await;
    let state = host
        .request(
            "POST",
            &format!("/documents/{id}/apply"),
            json!({"kind":"edit","base":state["snapshot"]["version"],"origin":"local","input":{"kind":"edits","edits":[{"from":2,"to":8,"insert":"MIDDLE"}]},"undo":{"metadata":null,"positions":[]}}),
        )
        .await["document"]
        .clone();
    feed.until(&id, |notice| {
        notice["version"] == state["snapshot"]["version"]
    })
    .await;
    let writer = state["writerId"].clone();
    let mut prior = state["snapshot"]["version"].clone();
    for text in ["A1 middle B1", "A2 middle B2", "A middle B"] {
        std::fs::write(root.path().join("a.md"), text).unwrap();
        let event = feed.until(&id, |notice| notice["version"] != prior).await;
        prior = event["version"].clone();
        let state = host.state(&id).await;
        assert_eq!(state["snapshot"]["text"], text.replace("middle", "MIDDLE"));
        assert_eq!(state["writerId"], writer);
        assert_eq!(state["conflict"], false);
    }
    let saved = host
        .request("POST", &format!("/documents/{id}/save"), prior.clone())
        .await;
    feed.until(&id, |notice| notice["dirty"] == false).await;
    assert_eq!(saved["snapshot"]["version"], prior);
    // Rewriting the exact bytes generates OS events but no further CRDT operation.
    std::fs::write(root.path().join("a.md"), "A MIDDLE B").unwrap();
    tokio::time::sleep(Duration::from_millis(160)).await;
    assert_eq!(host.state(&id).await["snapshot"]["version"], prior);
    let undone = host
        .request(
            "POST",
            &format!("/documents/{id}/apply"),
            json!({"kind":"undo","base":prior}),
        )
        .await;
    assert_eq!(undone["document"]["snapshot"]["text"], "A middle B");
    drop(feed);
    host.stop().await;
}

#[tokio::test]
async fn invalid_content_and_external_deletion_do_not_starve_other_files_or_destroy_drafts() {
    let root = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    for name in ["a.md", "b.md"] {
        std::fs::write(root.path().join(name), "base").unwrap();
    }
    let host = Host::start(root.path(), history.path(), false).await;
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
    let history = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), history.path(), true).await;
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

#[tokio::test]
async fn independent_replicas_follow_committed_changes_and_keep_their_personal_undo() {
    use celestite_core::{
        Buffer, BufferCommand, Edit, Import, SyncPacket, TextEdit, TextInput, UndoContext,
    };
    let root = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "left middle right").unwrap();
    let host = Host::start(root.path(), history.path(), false).await;
    let mut first = host.feed().await;
    let mut second = host.feed().await;
    let initial = first.next().await;
    second.next().await;
    let id = notice(&initial, "a.md")["id"].as_str().unwrap().to_owned();
    let seed: SyncPacket = serde_json::from_value(
        host.request("GET", &format!("/documents/{id}/snapshot"), Value::Null)
            .await,
    )
    .unwrap();
    let mut a = Buffer::from_snapshot(&seed, None).unwrap();
    let mut b = Buffer::from_snapshot(&seed, None).unwrap();
    let common = a.version();
    for (doc, from, to, text) in [(&mut a, 5, 11, "MIDDLE"), (&mut b, 12, 17, "RIGHT")] {
        let _ = doc
            .apply(BufferCommand::Edit(Edit {
                base: doc.version(),
                input: TextInput::Edits {
                    edits: vec![TextEdit {
                        from,
                        to,
                        insert: text.into(),
                    }],
                },
                origin: "local".into(),
                group: None,
                undo: UndoContext {
                    metadata: None,
                    positions: vec![],
                },
            }))
            .unwrap();
        let packet = doc.export_updates_since(&common).unwrap();
        host.request(
            "POST",
            &format!("/documents/{id}/apply"),
            json!({"kind":"import","packet":serde_json::to_value(packet).unwrap()}),
        )
        .await;
    }
    std::fs::write(root.path().join("a.md"), "LEFT middle right").unwrap();
    for feed in [&mut first, &mut second] {
        feed.until(&id, |notice| {
            notice["savedVersion"] != initial["documents"][0]["savedVersion"]
        })
        .await;
    }
    for doc in [&mut a, &mut b] {
        let packet: SyncPacket = serde_json::from_value(
            host.request(
                "POST",
                &format!("/documents/{id}/updates"),
                serde_json::to_value(doc.version()).unwrap(),
            )
            .await,
        )
        .unwrap();
        let _ = doc
            .apply(BufferCommand::Import(Import::new((packet).clone(), "host")))
            .unwrap();
        assert_eq!(doc.snapshot().text, "LEFT MIDDLE RIGHT");
    }
    assert_eq!(a.version(), b.version());
    let before = a.version();
    let _ = a
        .apply(BufferCommand::Undo {
            base: a.version(),
            context: UndoContext::default(),
        })
        .unwrap();
    assert_eq!(a.snapshot().text, "LEFT middle RIGHT");
    let accepted = host
        .request("POST", &format!("/documents/{id}/apply"), json!({"kind":"import","packet":serde_json::to_value(a.export_updates_since(&before).unwrap()).unwrap()}))
        .await;
    second
        .until(&id, |notice| {
            notice["version"] == accepted["document"]["snapshot"]["version"]
        })
        .await;
    let packet: SyncPacket = serde_json::from_value(
        host.request(
            "POST",
            &format!("/documents/{id}/updates"),
            serde_json::to_value(b.version()).unwrap(),
        )
        .await,
    )
    .unwrap();
    let _ = b
        .apply(BufferCommand::Import(Import::new((packet).clone(), "host")))
        .unwrap();
    assert_eq!(a.snapshot().text, b.snapshot().text);
    let _ = b
        .apply(BufferCommand::Undo {
            base: b.version(),
            context: UndoContext::default(),
        })
        .unwrap();
    assert_eq!(b.snapshot().text, "LEFT middle right");
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "LEFT middle right"
    );
    drop(first);
    drop(second);
    host.stop().await;
}
