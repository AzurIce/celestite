use axum::{body::Body, http::Request, Router};
use celestite_server::{build_server, Config, Permission, VaultConfig};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::fs;
use tower::ServiceExt;

struct Host {
    router: Router,
    key: String,
}
impl Host {
    async fn request(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/{}/api/v1{path}", self.key))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    async fn ok(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, value) = self.request(method, path, body).await;
        assert_eq!(status, 200, "{value}");
        value
    }
    async fn open(&self, path: &str) -> Value {
        self.ok("POST", "/documents/open", json!({"path":path}))
            .await
    }
    async fn edit(&self, document: &Value, text: &str) -> Value {
        self.ok(
            "POST",
            &format!("/documents/{}/apply", document["id"].as_str().unwrap()),
            json!({
                "kind":"edit", "base":document["snapshot"]["version"], "origin":"test",
                "input":{"kind":"text","text":text}, "undo":{"metadata":null,"positions":[]}
            }),
        )
        .await["document"]
            .clone()
    }
}

struct Fixture(tempfile::TempDir);
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a", "b", "web"] {
            fs::create_dir(dir.path().join(name)).unwrap();
        }
        fs::write(dir.path().join("a/note.md"), "disk").unwrap();
        fs::write(dir.path().join("a/unopened.md"), "other").unwrap();
        fs::write(dir.path().join("b/note.md"), "second vault").unwrap();
        fs::write(dir.path().join("web/index.html"), "UI").unwrap();
        Self(dir)
    }
    fn config(&self, root: &str) -> Config {
        Config {
            server: Default::default(),
            vault: VaultConfig {
                path: root.into(),
                share_key: Some("test-only stable secret 12345678901234567890".into()),
                ..Default::default()
            },
        }
    }
    fn start(&self, root: &str) -> Host {
        let server = build_server(self.config(root), self.0.path()).unwrap();
        Host {
            key: server.links.key(Permission::Edit).into(),
            router: server.router,
        }
    }
}

#[tokio::test]
async fn listing_and_observation_do_not_open_buffers_or_create_state_files() {
    let f = Fixture::new();
    let host = f.start("a");
    assert_eq!(host.ok("GET", "/documents", Value::Null).await, json!([]));
    let directory = host.ok("GET", "/directory?path=", Value::Null).await;
    assert_eq!(directory.as_array().unwrap().len(), 2);
    fs::write(f.0.path().join("a/unopened.md"), "changed before opening").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(host.ok("GET", "/documents", Value::Null).await, json!([]));
    let opened = host.open("note.md").await;
    assert!(opened["durableVersion"].is_null());
    assert_eq!(host.open("note.md").await["id"], opened["id"]);
    assert_eq!(
        host.ok("GET", "/documents", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        host.open("unopened.md").await["snapshot"]["text"],
        "changed before opening"
    );
    drop(host);
    let names: Vec<_> = fs::read_dir(f.0.path().join("a"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2);
    assert_eq!(fs::read_dir(f.0.path()).unwrap().count(), 3);
}

#[tokio::test]
async fn restart_uses_saved_bytes_and_rejects_previous_history() {
    let f = Fixture::new();
    let host = f.start("a");
    let before = host.ok("GET", "", Value::Null).await;
    let document = host.open("note.md").await;
    let document = host.edit(&document, "unsaved draft").await;
    let old_id = document["id"].as_str().unwrap();
    let packet = host
        .ok("GET", &format!("/documents/{old_id}/snapshot"), Value::Null)
        .await;
    assert_eq!(
        fs::read_to_string(f.0.path().join("a/note.md")).unwrap(),
        "disk"
    );
    drop(host);
    let host = f.start("a");
    let after = host.ok("GET", "", Value::Null).await;
    assert_eq!(before["vaultIdentity"]["id"], after["vaultIdentity"]["id"]);
    assert_ne!(
        before["vaultIdentity"]["historyId"],
        after["vaultIdentity"]["historyId"]
    );
    assert_eq!(after["capabilities"]["persistentHistory"], false);
    assert_eq!(host.ok("GET", "/documents", Value::Null).await, json!([]));
    assert_eq!(
        host.request("GET", &format!("/documents/{old_id}"), Value::Null)
            .await
            .0,
        404
    );
    let next = host.open("note.md").await;
    assert_ne!(next["id"], document["id"]);
    assert_eq!(next["snapshot"]["text"], "disk");
    let (status, _) = host
        .request(
            "POST",
            &format!("/documents/{}/apply", next["id"].as_str().unwrap()),
            json!({"kind":"import","packet":packet}),
        )
        .await;
    assert!(status >= 400);
    let saved = host.edit(&next, "saved text").await;
    host.ok(
        "POST",
        &format!("/documents/{}/save", saved["id"].as_str().unwrap()),
        saved["snapshot"]["version"].clone(),
    )
    .await;
    drop(host);
    assert_eq!(
        f.start("a").open("note.md").await["snapshot"]["text"],
        "saved text"
    );
}

#[tokio::test]
async fn directories_with_the_same_share_secret_have_distinct_identities() {
    let f = Fixture::new();
    let a = f.start("a");
    let b = f.start("b");
    assert_ne!(a.key, b.key);
    let first = a.ok("GET", "", Value::Null).await;
    let second = b.ok("GET", "", Value::Null).await;
    assert_ne!(first["vaultIdentity"]["id"], second["vaultIdentity"]["id"]);
    assert_eq!(b.open("note.md").await["snapshot"]["text"], "second vault");
}

#[test]
fn configuration_rejects_invalid_roots_and_overlapping_web_assets() {
    let f = Fixture::new();
    for path in ["missing", "a/note.md"] {
        assert!(build_server(f.config(path), f.0.path()).is_err());
    }
    fs::write(f.0.path().join("a/index.html"), "UI").unwrap();
    for web in ["a", "."] {
        let mut config = f.config("a");
        config.server.web_dir = Some(web.into());
        assert!(build_server(config, f.0.path()).is_err());
    }
    let mut config = f.config("a");
    config.server.web_dir = Some("web".into());
    assert!(build_server(config, f.0.path()).is_ok());
}

#[test]
fn obsolete_history_configuration_and_cli_flags_are_rejected() {
    for setting in [
        "state_dir = 'state'",
        "ephemeral = true",
        "history_mode = 'recover'",
    ] {
        assert!(toml::from_str::<Config>(&format!("[vault]\npath = 'a'\n{setting}\n")).is_err());
    }
    for flag in [
        "--init-vault",
        "--reset-vault",
        "--ephemeral",
        "--state-dir",
    ] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_celestite-server"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("unexpected argument"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn canonical_directory_aliases_preserve_configured_share_identity() {
    let f = Fixture::new();
    std::os::unix::fs::symlink("a", f.0.path().join("alias")).unwrap();
    let first = f.start("a");
    let key = first.key.clone();
    drop(first);
    assert_eq!(f.start("alias").key, key);
}
