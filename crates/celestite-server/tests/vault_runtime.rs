mod support;
use celestite_server::{build_server, Config, VaultConfig};
use serde_json::{json, Value};
use std::fs;

struct Host {
    server: support::Host,
    key: String,
}
impl Host {
    async fn request(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let response = self.server.request(method, path, body).await;
        let status = response.status().as_u16();
        (status, response.json().await.unwrap())
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
    async fn start(&self, root: &str) -> Host {
        let server = support::Host::start(&self.0.path().join(root), false).await;
        let key = server.url.split('/').nth(3).unwrap().to_owned();
        Host { server, key }
    }
}

#[tokio::test]
async fn listing_does_not_open_buffers_or_create_state_files() {
    let f = Fixture::new();
    let host = f.start("a").await;
    assert_eq!(host.ok("GET", "/documents", Value::Null).await, json!([]));
    let directory = host.ok("GET", "/directory?path=", Value::Null).await;
    assert_eq!(directory.as_array().unwrap().len(), 2);
    let opened = host.open("note.md").await;
    assert!(opened["durableVersion"].is_null());
    drop(host);
    let names: Vec<_> = fs::read_dir(f.0.path().join("a"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2);
    assert_eq!(fs::read_dir(f.0.path()).unwrap().count(), 3);
}

#[tokio::test]
async fn directories_with_the_same_share_secret_have_distinct_identities() {
    let f = Fixture::new();
    let a = f.start("a").await;
    let b = f.start("b").await;
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
    let first = f.start("a").await;
    let key = first.key.clone();
    drop(first);
    assert_eq!(f.start("alias").await.key, key);
}
