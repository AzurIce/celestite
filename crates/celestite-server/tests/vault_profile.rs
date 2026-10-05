//! Profile lifecycle and isolation through the public server configuration/API.
use axum::{body::Body, http::Request, Router};
use celestite_core::SyncPacket;
use celestite_server::{build_server, Config, HistoryMode, VaultConfig};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tower::ServiceExt;

struct Host {
    router: Router,
    key: String,
}
impl Host {
    fn url(&self, tail: &str) -> String {
        format!("/{}/api/v1{tail}", self.key)
    }
}

struct Fixture {
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for path in ["a", "b", "state-a", "state-b", "web"] {
            fs::create_dir(dir.path().join(path)).unwrap();
        }
        fs::write(dir.path().join("a/note.md"), "disk").unwrap();
        fs::write(dir.path().join("b/note.md"), "other").unwrap();
        fs::write(dir.path().join("web/index.html"), "UI").unwrap();
        Self { dir }
    }
    fn path(&self, path: &str) -> PathBuf {
        self.dir.path().join(path)
    }
    fn vault(&self, id: &str, mode: HistoryMode) -> VaultConfig {
        VaultConfig {
            name: id.into(),
            path: id.into(),
            state_dir: Some(format!("state-{id}").into()),
            history_mode: mode,
            ..Default::default()
        }
    }
    fn config(&self, mode: HistoryMode) -> Config {
        Config {
            server: Default::default(),
            vault: self.vault("a", mode),
        }
    }
    fn router(&self, config: Config) -> Host {
        let server = build_server(config, self.dir.path()).unwrap();
        let key = server
            .links
            .key(celestite_server::Permission::Edit)
            .to_owned();
        Host {
            router: server.router,
            key,
        }
    }
    fn rejects(&self, config: Config) {
        assert!(build_server(config, self.dir.path()).is_err());
    }
}
async fn request(router: &Host, method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = router
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}
async fn ok(router: &Host, method: &str, path: &str, body: Value) -> Value {
    let (status, value) = request(router, method, path, body).await;
    assert_eq!(status, 200, "{value}");
    value
}
async fn open(router: &Host) -> Value {
    ok(
        router,
        "POST",
        &router.url("/documents/open"),
        json!({"path":"note.md"}),
    )
    .await
}

#[test]
fn recovery_never_initializes_missing_or_invalid_profiles() {
    let f = Fixture::new();
    f.rejects(f.config(HistoryMode::Recover));
    assert!(!f.path("state-a/history.redb").exists());
    let mut no_state = f.config(HistoryMode::Recover);
    no_state.vault.state_dir = None;
    f.rejects(no_state);
    fs::write(f.path("state-a/history.redb"), "broken database").unwrap();
    f.rejects(f.config(HistoryMode::Recover));
    f.rejects(f.config(HistoryMode::Initialize));
    assert_eq!(
        fs::read(f.path("state-a/history.redb")).unwrap(),
        b"broken database"
    );
    fs::remove_file(f.path("state-a/history.redb")).unwrap();
    drop(redb::Database::create(f.path("state-a/history.redb")).unwrap());
    f.rejects(f.config(HistoryMode::Recover));
}

#[test]
fn configuration_is_validated_before_history_is_initialized() {
    let f = Fixture::new();
    for state in ["a", "a/private", "web", "."] {
        fs::create_dir_all(f.path(state)).unwrap();
        let mut config = f.config(HistoryMode::Initialize);
        config.vault.state_dir = Some(state.into());
        config.server.web_dir = Some("web".into());
        f.rejects(config);
        assert!(!f.path(state).join("history.redb").exists());
    }
    let mut config = f.config(HistoryMode::Initialize);
    config.server.web_dir = Some("a".into());
    f.rejects(config);
    assert!(!f.path("state-a/history.redb").exists());
}

#[test]
fn profiles_have_one_owner_and_initialization_cannot_overwrite() {
    let f = Fixture::new();
    let router = f.router(f.config(HistoryMode::Initialize));
    for mode in [
        HistoryMode::Initialize,
        HistoryMode::Recover,
        HistoryMode::Reset,
    ] {
        f.rejects(f.config(mode));
    }
    drop(router);
    f.rejects(f.config(HistoryMode::Initialize));
    let mut other_root = f.config(HistoryMode::Recover);
    other_root.vault.path = "b".into();
    f.rejects(other_root);
    drop(f.router(f.config(HistoryMode::Recover)));
    fs::remove_file(f.path("state-a/history.redb")).unwrap();
    f.rejects(f.config(HistoryMode::Recover));
    assert!(!f.path("state-a/history.redb").exists());
}

#[test]
fn cli_share_keys_fail_before_initializing_history() {
    let f = Fixture::new();
    for key in [None, Some("short")] {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_celestite-server"));
        command.current_dir(f.dir.path()).args([
            "--no-config",
            "--vault",
            "a",
            "--state-dir",
            "state-a",
            "--init-vault",
        ]);
        if let Some(key) = key {
            command.args(["--share-key", key]);
        }
        let result = command.output().unwrap();
        assert!(!result.status.success());
        let error = String::from_utf8_lossy(&result.stderr);
        let expected = if key.is_none() {
            "--share-key"
        } else {
            "at least 32 bytes"
        };
        assert!(error.contains(expected), "{error}");
        assert!(!f.path("state-a/history.redb").exists());
    }
}

#[test]
fn lifecycle_commands_exit_without_listening_and_cannot_repeat_initialization() {
    let f = Fixture::new();
    // An occupied port makes this test fail promptly if setup tries to serve HTTP.
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = occupied.local_addr().unwrap().to_string();
    let run = |action| {
        std::process::Command::new(env!("CARGO_BIN_EXE_celestite-server"))
            .current_dir(f.dir.path())
            .args([
                "--no-config",
                "--listen",
                &address,
                "--vault",
                "a",
                "--share-key",
                "0123456789abcdef0123456789abcdef",
                "--state-dir",
                "state-a",
                action,
            ])
            .output()
            .unwrap()
    };
    let initialized = run("--init-vault");
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );
    assert!(!run("--init-vault").status.success());
    assert!(run("--reset-vault").status.success());
    drop(f.router(f.config(HistoryMode::Recover)));
}

#[tokio::test]
async fn independent_servers_preserve_isolated_history_across_restart_and_rename() {
    let f = Fixture::new();
    let router = f.router(f.config(HistoryMode::Initialize));
    let other = f.router(Config {
        server: Default::default(),
        vault: f.vault("b", HistoryMode::Initialize),
    });
    let a = open(&router).await;
    let b = open(&other).await;
    assert_ne!(
        a["snapshot"]["version"]["identity"],
        b["snapshot"]["version"]["identity"]
    );
    let before = ok(&router, "GET", &router.url(""), Value::Null).await;
    let route = format!(
        "{}/documents/{}/transact",
        router.url(""),
        a["id"].as_str().unwrap()
    );
    let committed = ok(
        &router,
        "POST",
        &route,
        json!({
            "expected_version": a["snapshot"]["version"], "origin":"test",
            "edits":[{"from":0,"to":0,"insert":"unsaved "}],
            "undo_metadata":null, "undo_positions":[]
        }),
    )
    .await;
    let saved = &committed["document"];
    assert_eq!(saved["snapshot"]["text"], "unsaved disk");
    assert_eq!(saved["durableVersion"], saved["snapshot"]["version"]);
    assert_eq!(fs::read_to_string(f.path("a/note.md")).unwrap(), "disk");
    drop(router);
    let mut config = f.config(HistoryMode::Recover);
    config.vault.name = "New display name".into();
    let router = f.router(config);
    let after = ok(&router, "GET", &router.url(""), Value::Null).await;
    assert_eq!(before["vaultIdentity"], after["vaultIdentity"]);
    assert_eq!(after["capabilities"]["persistentHistory"], true);
    let restored = open(&router).await;
    for key in ["id", "snapshot", "durableVersion", "savedVersion", "dirty"] {
        assert_eq!(restored[key], saved[key], "{key}");
    }
    assert_eq!(open(&other).await["snapshot"], b["snapshot"]);
    drop(other);
    let other = f.router(Config {
        server: Default::default(),
        vault: f.vault("b", HistoryMode::Recover),
    });
    assert_eq!(open(&other).await["snapshot"], b["snapshot"]);
}

#[tokio::test]
async fn explicit_reset_archives_unsaved_history_and_rejects_old_packets() {
    let f = Fixture::new();
    let router = f.router(f.config(HistoryMode::Initialize));
    let initial = open(&router).await;
    let id = initial["id"].as_str().unwrap();
    ok(
        &router,
        "POST",
        &router.url(&format!("/documents/{id}/transact")),
        json!({
            "expected_version":initial["snapshot"]["version"], "origin":"test",
            "edits":[{"from":0,"to":0,"insert":"old draft "}],
            "undo_metadata":null, "undo_positions":[]
        }),
    )
    .await;
    let packet = ok(
        &router,
        "GET",
        &router.url(&format!("/documents/{id}/snapshot")),
        Value::Null,
    )
    .await;
    drop(router);
    let router = f.router(f.config(HistoryMode::Reset));
    let new = open(&router).await;
    assert_ne!(new["id"], initial["id"]);
    assert_ne!(
        new["snapshot"]["version"]["identity"],
        initial["snapshot"]["version"]["identity"]
    );
    assert_eq!(new["snapshot"]["text"], "disk");
    let (status, _) = request(
        &router,
        "POST",
        &format!(
            "{}/documents/{}/import",
            router.url(""),
            new["id"].as_str().unwrap()
        ),
        packet.clone(),
    )
    .await;
    assert_eq!(status, 409);
    drop(router);
    let archive = fs::read_dir(f.path("state-a"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.is_dir())
        .unwrap();
    let mut config = f.config(HistoryMode::Recover);
    config.vault.state_dir = Some(archive);
    let router = f.router(config);
    let old = open(&router).await;
    assert_eq!(old["id"], initial["id"]);
    assert_eq!(old["snapshot"]["text"], "old draft disk");
    let _: SyncPacket = serde_json::from_value(packet).unwrap();
}

#[test]
fn ephemeral_is_explicit_and_cannot_initialize_or_reset() {
    let f = Fixture::new();
    for mode in [
        HistoryMode::Recover,
        HistoryMode::Initialize,
        HistoryMode::Reset,
    ] {
        let mut config = f.config(mode);
        config.vault.ephemeral = true;
        f.rejects(config);
    }
    let mut config = f.config(HistoryMode::Recover);
    config.vault.ephemeral = true;
    config.vault.state_dir = None;
    drop(f.router(config));
    assert!(!f.path("state-a/history.redb").exists());
}

#[cfg(unix)]
#[test]
fn canonical_paths_prevent_aliases_and_history_symlinks() {
    let f = Fixture::new();
    std::os::unix::fs::symlink(f.path("a"), f.path("state-alias")).unwrap();
    let mut config = f.config(HistoryMode::Initialize);
    config.vault.state_dir = Some("state-alias".into());
    f.rejects(config);
    drop(f.router(f.config(HistoryMode::Initialize)));
    fs::rename(
        f.path("state-a/history.redb"),
        f.path("state-a/original.redb"),
    )
    .unwrap();
    std::os::unix::fs::symlink(Path::new("original.redb"), f.path("state-a/history.redb")).unwrap();
    f.rejects(f.config(HistoryMode::Recover));
    f.rejects(f.config(HistoryMode::Reset));
    f.rejects(f.config(HistoryMode::Initialize));
}
