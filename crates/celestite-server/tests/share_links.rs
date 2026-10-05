use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use celestite_server::{build_server, Config, HistoryMode, Permission, Server, VaultConfig};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{fs, time::Duration};
use tower::ServiceExt;

struct Fixture {
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for path in ["notes", "state"] {
            fs::create_dir(dir.path().join(path)).unwrap();
        }
        fs::write(dir.path().join("notes/a.md"), "original").unwrap();
        Self { dir }
    }
    fn config(&self, mode: HistoryMode) -> Config {
        Config {
            server: Default::default(),
            vaults: vec![VaultConfig {
                id: "notes".into(),
                name: "Private notes".into(),
                path: "notes".into(),
                state_dir: Some("state".into()),
                history_mode: mode,
                ..Default::default()
            }],
        }
    }
    fn start(&self, mode: HistoryMode) -> Server {
        build_server(self.config(mode), self.dir.path()).unwrap()
    }
}
fn uri(key: &str, tail: &str) -> String {
    format!("/{key}/api/v1{tail}")
}
async fn response(
    router: &Router,
    key: &str,
    method: &str,
    tail: &str,
    value: Value,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri(key, tail))
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn read(response: axum::response::Response) -> Value {
    assert!(response.status().is_success());
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn independent_links_share_identity_and_readonly_blocks_every_write_entry() {
    let f = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let reader = server
        .create_share("notes", Permission::Readonly, "Readers".into())
        .unwrap();
    let editor = server
        .create_share("notes", Permission::Edit, "Editors".into())
        .unwrap();
    assert!(reader.key.starts_with("ro-"));
    assert!(!editor.key.starts_with("ro-"));
    let ro = read(response(&server.router, &reader.key, "GET", "", Value::Null).await).await;
    let rw = read(response(&server.router, &editor.key, "GET", "", Value::Null).await).await;
    assert_eq!(ro["vaultIdentity"], rw["vaultIdentity"]);
    assert_eq!(ro["shareId"], reader.share.id);
    assert_eq!(ro["readOnly"], true);
    assert_eq!(rw["readOnly"], false);
    assert!(ro.get("id").is_none());
    for invalid in [
        reader.key.trim_start_matches("ro-").to_string(),
        format!("ro-{}", editor.key),
        "notes".into(),
    ] {
        assert_eq!(
            response(&server.router, &invalid, "GET", "", Value::Null)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let document = read(
        response(
            &server.router,
            &reader.key,
            "POST",
            "/documents/open",
            json!({"path":"a.md"}),
        )
        .await,
    )
    .await;
    let id = document["id"].as_str().unwrap();
    assert_eq!(document["snapshot"]["text"], "original");
    let version = &document["snapshot"]["version"];
    let updates = response(
        &server.router,
        &reader.key,
        "POST",
        &format!("/documents/{id}/updates"),
        version.clone(),
    )
    .await;
    assert_eq!(updates.status(), StatusCode::OK);
    for tail in [
        "transact",
        "import",
        "undo",
        "redo",
        "save",
        "client-commit",
        "retry-observation",
    ] {
        assert_eq!(
            response(
                &server.router,
                &reader.key,
                "POST",
                &format!("/documents/{id}/{tail}"),
                json!({})
            )
            .await
            .status(),
            StatusCode::FORBIDDEN,
            "{tail}"
        );
    }
    for (method, tail) in [
        ("PUT", "/file?path=a.md"),
        ("POST", "/directory?path=new"),
        ("POST", "/rename"),
        ("DELETE", "/entry?path=a.md"),
    ] {
        assert_eq!(
            response(&server.router, &reader.key, method, tail, json!({}))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let edited = read(response(&server.router, &editor.key, "POST", &format!("/documents/{id}/transact"), json!({
        "expected_version": version, "origin":"test", "edits":[{"from":0,"to":0,"insert":"edited "}], "undo_metadata":null,"undo_positions":[]
    })).await).await;
    assert_eq!(edited["document"]["snapshot"]["text"], "edited original");
    let visible = read(
        response(
            &server.router,
            &reader.key,
            "GET",
            &format!("/documents/{id}"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(visible["snapshot"]["text"], "edited original");
    assert_eq!(
        fs::read_to_string(f.dir.path().join("notes/a.md")).unwrap(),
        "original"
    );
    for path in ["/api/v1/vaults/notes", "/vaults/notes/shares"] {
        assert_eq!(
            server
                .router
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn revocation_closes_both_event_feeds_without_affecting_other_links() {
    let f = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let reader = server
        .create_share("notes", Permission::Readonly, "Reader".into())
        .unwrap();
    let other = server
        .create_share("notes", Permission::Edit, "Editor".into())
        .unwrap();
    let mut feeds = Vec::new();
    for tail in ["/events", "/documents/events"] {
        let response = response(&server.router, &reader.key, "GET", tail, Value::Null).await;
        assert_eq!(response.headers()["cache-control"], "no-store");
        let mut body = response.into_body();
        body.frame().await.unwrap().unwrap();
        feeds.push(body);
    }
    server
        .revoke_share("notes", &reader.share.id)
        .await
        .unwrap();
    for mut body in feeds {
        assert!(tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none());
    }
    assert_eq!(
        response(&server.router, &reader.key, "GET", "", Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        response(&server.router, &other.key, "GET", "", Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(server.list_shares("notes").unwrap().len(), 1);
}

#[tokio::test]
async fn restart_and_config_rename_preserve_links_and_durable_revocation() {
    let f = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let alive = server
        .create_share("notes", Permission::Edit, "Keep".into())
        .unwrap();
    let revoked = server
        .create_share("notes", Permission::Readonly, "Remove".into())
        .unwrap();
    server
        .revoke_share("notes", &revoked.share.id)
        .await
        .unwrap();
    let before = read(response(&server.router, &alive.key, "GET", "", Value::Null).await).await;
    drop(server);
    let mut config = f.config(HistoryMode::Recover);
    config.vaults[0].id = "renamed".into();
    config.vaults[0].name = "Renamed notes".into();
    let server = build_server(config, f.dir.path()).unwrap();
    let after = read(response(&server.router, &alive.key, "GET", "", Value::Null).await).await;
    assert_eq!(before["vaultIdentity"], after["vaultIdentity"]);
    assert_eq!(before["shareId"], after["shareId"]);
    assert_eq!(after["name"], "Renamed notes");
    assert_eq!(
        response(&server.router, &revoked.key, "GET", "", Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    drop(server);
    let server = f.start(HistoryMode::Reset);
    assert_eq!(
        response(&server.router, &alive.key, "GET", "", Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(server.list_shares("notes").unwrap().is_empty());
}

#[test]
fn missing_share_store_requires_explicit_initialization() {
    let f = Fixture::new();
    drop(f.start(HistoryMode::Initialize));
    fs::remove_file(f.dir.path().join("state/shares.redb")).unwrap();
    assert!(build_server(f.config(HistoryMode::Recover), f.dir.path()).is_err());
    let mut config = f.config(HistoryMode::Recover);
    config.vaults[0].initialize_shares = true;
    let server = build_server(config, f.dir.path()).unwrap();
    assert!(server.list_shares("notes").unwrap().is_empty());
}

#[tokio::test]
async fn websocket_url_authenticates_before_upgrade_and_revocation_closes_the_session() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    let f = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let reader = server
        .create_share("notes", Permission::Readonly, "Socket reader".into())
        .unwrap();
    let description =
        read(response(&server.router, &reader.key, "GET", "", Value::Null).await).await;
    let document = read(
        response(
            &server.router,
            &reader.key,
            "POST",
            "/documents/open",
            json!({"path":"a.md"}),
        )
        .await,
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = server.router.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let invalid = format!(
        "ws://{address}{}/sync",
        uri(reader.key.trim_start_matches("ro-"), "")
    );
    assert!(
        matches!(connect_async(invalid).await.unwrap_err(), tokio_tungstenite::tungstenite::Error::Http(reply) if reply.status()==404)
    );
    let (mut socket, _) = connect_async(format!("ws://{address}{}/sync", uri(&reader.key, "")))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({"protocolVersion":1,"vaultIdentity":description["vaultIdentity"]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let mut session = Value::Null;
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(text) = frame else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["kind"] == "hello" {
            session = value["sessionId"].clone();
        }
        if value["kind"] == "ready" {
            break;
        }
    }
    socket.send(Message::Text(json!({"sessionId":session,"requestId":1,"method":"save","id":document["id"],"version":document["snapshot"]["version"]}).to_string().into())).await.unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(text) = frame else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["kind"] == "reply" {
            assert_eq!(value["error"]["code"], "PermissionDenied");
            break;
        }
    }
    server
        .revoke_share("notes", &reader.share.id)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(frame) = socket.next().await {
            if matches!(frame, Ok(Message::Close(_)) | Err(_)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
}

#[test]
fn share_store_keeps_only_digests_and_rejects_corruption_or_another_vault_identity() {
    let f = Fixture::new();
    let other = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let reader = server
        .create_share("notes", Permission::Readonly, "Readers".into())
        .unwrap();
    let list = serde_json::to_value(server.list_shares("notes").unwrap()).unwrap();
    assert!(list[0].get("key").is_none());
    assert!(list[0].get("keyHash").is_none());
    assert_eq!(list[0]["label"], "Readers");
    drop(server);
    let path = f.dir.path().join("state/shares.redb");
    let bytes = fs::read(&path).unwrap();
    assert!(!bytes
        .windows(reader.key.len())
        .any(|part| part == reader.key.as_bytes()));
    drop(other.start(HistoryMode::Initialize));
    fs::copy(other.dir.path().join("state/shares.redb"), &path).unwrap();
    assert!(build_server(f.config(HistoryMode::Recover), f.dir.path()).is_err());
    fs::write(&path, b"corrupted share database").unwrap();
    assert!(build_server(f.config(HistoryMode::Recover), f.dir.path()).is_err());
}
