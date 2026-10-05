//! Profile lifecycle and isolation through the public server configuration/API.
use axum::{body::Body, http::Request, Router};
use celestite_core::SyncPacket;
use celestite_server::{build_server, Config, HistoryMode, ServerConfig, VaultConfig};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tower::ServiceExt;

struct Host {
    router: Router,
    keys: HashMap<String, String>,
}
impl Host {
    fn url(&self, vault: &str, tail: &str) -> String {
        format!("/{}/api/v1{tail}", self.keys[vault])
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
            id: id.into(),
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
            vaults: vec![self.vault("a", mode)],
        }
    }
    fn router(&self, config: Config) -> Host {
        let ids: Vec<_> = config.vaults.iter().map(|v| v.id.clone()).collect();
        let server = build_server(config, self.dir.path()).unwrap();
        let keys = ids
            .into_iter()
            .map(|id| {
                let key = server
                    .create_share(
                        &id,
                        celestite_server::Permission::Edit,
                        "profile-test".into(),
                    )
                    .unwrap()
                    .key;
                (id, key)
            })
            .collect();
        Host {
            router: server.router,
            keys,
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
async fn open(router: &Host, vault: &str) -> Value {
    ok(
        router,
        "POST",
        &router.url(vault, "/documents/open"),
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
    no_state.vaults[0].state_dir = None;
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
fn configuration_is_validated_before_any_profile_is_initialized() {
    let f = Fixture::new();
    for state in ["state-a", "state-a/nested", "a/private", "web"] {
        fs::create_dir_all(f.path(state)).unwrap();
        let mut config = f.config(HistoryMode::Initialize);
        let mut second = f.vault("b", HistoryMode::Initialize);
        second.state_dir = Some(state.into());
        config.vaults.push(second);
        config.server.web_dir = Some("web".into());
        f.rejects(config);
        assert!(!f.path("state-a/history.redb").exists());
    }
    // The first profile must also be checked against later Vault roots.
    let mut config = f.config(HistoryMode::Initialize);
    config.vaults[0].state_dir = Some("b".into());
    config.vaults.push(f.vault("b", HistoryMode::Initialize));
    f.rejects(config);
    assert!(!f.path("b/history.redb").exists());
    let mut config = f.config(HistoryMode::Initialize);
    config.server.web_dir = Some("a".into());
    f.rejects(config);
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
    other_root.vaults[0].path = "b".into();
    f.rejects(other_root);
    drop(f.router(f.config(HistoryMode::Recover)));
    fs::remove_file(f.path("state-a/history.redb")).unwrap();
    f.rejects(f.config(HistoryMode::Recover));
    assert!(!f.path("state-a/history.redb").exists());
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
                "a=a",
                "--vault-state-dir",
                "a=state-a",
                action,
                "a",
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
async fn each_vault_preserves_identity_and_unsaved_history_across_restart_and_url_changes() {
    let f = Fixture::new();
    let mut config = f.config(HistoryMode::Initialize);
    config.vaults.push(f.vault("b", HistoryMode::Initialize));
    let router = f.router(config);
    let a = open(&router, "a").await;
    let b = open(&router, "b").await;
    assert_ne!(
        a["snapshot"]["version"]["identity"],
        b["snapshot"]["version"]["identity"]
    );
    let before = ok(&router, "GET", &router.url("a", ""), Value::Null).await;
    let route = format!(
        "{}/documents/{}/transact",
        router.url("a", ""),
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
    config.vaults[0].id = "renamed-url".into();
    config.vaults[0].name = "New display name".into();
    config.vaults.push(f.vault("b", HistoryMode::Recover));
    let router = f.router(config);
    let after = ok(&router, "GET", &router.url("renamed-url", ""), Value::Null).await;
    assert_eq!(before["vaultIdentity"], after["vaultIdentity"]);
    assert_eq!(after["capabilities"]["persistentHistory"], true);
    let restored = open(&router, "renamed-url").await;
    for key in ["id", "snapshot", "durableVersion", "savedVersion", "dirty"] {
        assert_eq!(restored[key], saved[key], "{key}");
    }
    assert_eq!(open(&router, "b").await["snapshot"], b["snapshot"]);
}

#[tokio::test]
async fn explicit_reset_archives_unsaved_history_and_rejects_old_packets() {
    let f = Fixture::new();
    let router = f.router(f.config(HistoryMode::Initialize));
    let initial = open(&router, "a").await;
    let id = initial["id"].as_str().unwrap();
    ok(
        &router,
        "POST",
        &router.url("a", &format!("/documents/{id}/transact")),
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
        &router.url("a", &format!("/documents/{id}/snapshot")),
        Value::Null,
    )
    .await;
    drop(router);
    let router = f.router(f.config(HistoryMode::Reset));
    let new = open(&router, "a").await;
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
            router.url("a", ""),
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
    config.vaults[0].state_dir = Some(archive);
    // Recovering archived history starts a new sharing store; revoked links stay revoked.
    config.vaults[0].initialize_shares = true;
    let router = f.router(config);
    let old = open(&router, "a").await;
    assert_eq!(old["id"], initial["id"]);
    assert_eq!(old["snapshot"]["text"], "old draft disk");
    let _: SyncPacket = serde_json::from_value(packet).unwrap();
}

#[tokio::test]
async fn legacy_shared_state_retains_existing_profiles() {
    let f = Fixture::new();
    let config = |mode| Config {
        server: ServerConfig {
            state_dir: Some("state-a".into()),
            ..Default::default()
        },
        vaults: ["a", "b"]
            .into_iter()
            .map(|id| VaultConfig {
                state_dir: None,
                ..f.vault(id, mode)
            })
            .collect(),
    };
    let router = f.router(config(HistoryMode::Initialize));
    let initial = open(&router, "a").await;
    assert!(f.path("state-a/a.redb").exists());
    assert!(f.path("state-a/b.redb").exists());
    drop(router);
    let router = f.router(config(HistoryMode::Recover));
    assert_eq!(open(&router, "a").await["snapshot"], initial["snapshot"]);
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
        config.vaults[0].ephemeral = true;
        f.rejects(config);
    }
    let mut config = f.config(HistoryMode::Recover);
    config.vaults[0].ephemeral = true;
    config.vaults[0].state_dir = None;
    let mut invalid = f.config(HistoryMode::Recover);
    invalid.vaults[0].ephemeral = true;
    invalid.vaults[0].state_dir = None;
    invalid.vaults[0].initialize_shares = true;
    f.rejects(invalid);
    drop(f.router(config));
    assert!(!f.path("state-a/history.redb").exists());
}

#[cfg(unix)]
#[test]
fn canonical_paths_prevent_aliases_and_history_symlinks() {
    let f = Fixture::new();
    std::os::unix::fs::symlink(f.path("state-a"), f.path("state-alias")).unwrap();
    let mut config = f.config(HistoryMode::Initialize);
    let mut second = f.vault("b", HistoryMode::Initialize);
    second.state_dir = Some("state-alias".into());
    config.vaults.push(second);
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
