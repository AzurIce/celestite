use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use celestite_server::{Config, HistoryMode, Permission, Server, VaultConfig, build_server};
use http_body_util::BodyExt;
use serde_json::{Value, json};
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
            vault: VaultConfig {
                name: "Private notes".into(),
                path: "notes".into(),
                state_dir: Some("state".into()),
                history_mode: mode,
                ..Default::default()
            },
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
    let reader = server.links.key(Permission::Readonly).to_owned();
    let editor = server.links.key(Permission::Edit).to_owned();
    assert!(reader.starts_with("ro-"));
    assert!(!editor.starts_with("ro-"));
    let ro = read(response(&server.router, &reader, "GET", "", Value::Null).await).await;
    let rw = read(response(&server.router, &editor, "GET", "", Value::Null).await).await;
    assert_eq!(ro["vaultIdentity"], rw["vaultIdentity"]);
    assert_ne!(ro["shareId"], rw["shareId"]);
    assert_eq!(ro["readOnly"], true);
    assert_eq!(rw["readOnly"], false);
    assert!(ro.get("id").is_none());
    for invalid in [
        reader.trim_start_matches("ro-").to_string(),
        format!("ro-{}", editor),
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
            &reader,
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
        &reader,
        "POST",
        &format!("/documents/{id}/updates"),
        version.clone(),
    )
    .await;
    assert_eq!(updates.status(), StatusCode::OK);
    for tail in ["apply", "save", "client-commit", "retry-observation"] {
        assert_eq!(
            response(
                &server.router,
                &reader,
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
            response(&server.router, &reader, method, tail, json!({}))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let edited = read(response(&server.router, &editor, "POST", &format!("/documents/{id}/apply"), json!({"kind":"edit","base":version,"origin":"test","input":{"kind":"edits","edits":[{"from":0,"to":0,"insert":"edited "}]},"undo":{"metadata":null,"positions":[]}})).await).await;
    assert_eq!(edited["document"]["snapshot"]["text"], "edited original");
    let visible = read(
        response(
            &server.router,
            &reader,
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
async fn restart_and_display_rename_preserve_links_and_key_rotation_invalidates_both_roles() {
    let f = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let reader = server.links.key(Permission::Readonly).to_owned();
    let editor = server.links.key(Permission::Edit).to_owned();
    let before = read(response(&server.router, &editor, "GET", "", Value::Null).await).await;
    drop(server);
    let mut config = f.config(HistoryMode::Recover);
    config.vault.name = "Renamed notes".into();
    let server = build_server(config, f.dir.path()).unwrap();
    assert_eq!(server.links.key(Permission::Readonly), reader.as_str());
    assert_eq!(server.links.key(Permission::Edit), editor.as_str());
    let after = read(response(&server.router, &editor, "GET", "", Value::Null).await).await;
    assert_eq!(before["vaultIdentity"], after["vaultIdentity"]);
    assert_eq!(before["shareId"], after["shareId"]);
    drop(server);
    let mut config = f.config(HistoryMode::Recover);
    config.vault.share_key = Some("new randomly chosen secret value 1234567890".into());
    let server = build_server(config, f.dir.path()).unwrap();
    for old in [&reader, &editor] {
        assert_eq!(
            response(&server.router, old, "GET", "", Value::Null)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let rotated = server.links.key(Permission::Edit).to_owned();
    let after = read(response(&server.router, &rotated, "GET", "", Value::Null).await).await;
    assert_eq!(before["vaultIdentity"], after["vaultIdentity"]);
    drop(server);
    let mut config = f.config(HistoryMode::Recover);
    config.vault.share_key = Some("new randomly chosen secret value 1234567890".into());
    let server = build_server(config, f.dir.path()).unwrap();
    assert_eq!(server.links.key(Permission::Edit), rotated.as_str());
    drop(server);
    let mut config = f.config(HistoryMode::Reset);
    config.vault.share_key = Some("new randomly chosen secret value 1234567890".into());
    let server = build_server(config, f.dir.path()).unwrap();
    assert_eq!(
        response(&server.router, &rotated, "GET", "", Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn shutdown_ends_both_event_feeds() {
    let f = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let reader = server.links.key(Permission::Readonly);
    let mut feeds = Vec::new();
    for tail in ["/events", "/documents/events"] {
        let response = response(&server.router, reader, "GET", tail, Value::Null).await;
        assert_eq!(response.headers()["cache-control"], "no-store");
        let mut body = response.into_body();
        body.frame().await.unwrap().unwrap();
        feeds.push(body);
    }
    server.shutdown.send_replace(true);
    for mut body in feeds {
        assert!(
            tokio::time::timeout(Duration::from_secs(1), body.frame())
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn existing_history_automatically_acquires_a_private_seed_without_share_initialization() {
    use redb::TableDefinition;
    let f = Fixture::new();
    drop(f.start(HistoryMode::Initialize));
    let path = f.dir.path().join("state/history.redb");
    let db = redb::Database::open(&path).unwrap();
    let tx = db.begin_write().unwrap();
    tx.open_table(TableDefinition::<&str, &[u8]>::new("editor_metadata"))
        .unwrap()
        .remove("share-seed")
        .unwrap();
    tx.commit().unwrap();
    drop(db);
    let server = f.start(HistoryMode::Recover);
    let key = server.links.key(Permission::Edit).to_owned();
    assert_ne!(server.links.readonly, server.links.edit);
    assert!(!f.dir.path().join("state/shares.redb").exists());
    drop(server);
    assert!(
        !fs::read(&path)
            .unwrap()
            .windows(key.len())
            .any(|part| part == key.as_bytes())
    );
    let server = f.start(HistoryMode::Recover);
    assert_eq!(server.links.key(Permission::Edit), key.as_str());
    drop(server);
    let db = redb::Database::open(&path).unwrap();
    let tx = db.begin_write().unwrap();
    tx.open_table(TableDefinition::<&str, &[u8]>::new("editor_metadata"))
        .unwrap()
        .insert("share-seed", b"corrupted".as_slice())
        .unwrap();
    tx.commit().unwrap();
    drop(db);
    assert!(build_server(f.config(HistoryMode::Recover), f.dir.path()).is_err());
}

#[test]
fn public_url_and_configured_secrets_are_validated_before_initialization() {
    let f = Fixture::new();
    let mut config = f.config(HistoryMode::Initialize);
    config.vault.share_key = Some("a public name".into());
    assert!(build_server(config, f.dir.path()).is_err());
    assert!(!f.dir.path().join("state/history.redb").exists());
    for invalid in [
        "ftp://host",
        "https://user:pass@host",
        "https://host/?",
        "https://host/#",
    ] {
        let mut config = f.config(HistoryMode::Initialize);
        config.server.public_url = Some(invalid.into());
        assert!(build_server(config, f.dir.path()).is_err());
        assert!(!f.dir.path().join("state/history.redb").exists());
    }
    let listen = "127.0.0.1:7437".parse().unwrap();
    assert_eq!(
        celestite_server::connection_base_url(None, listen).unwrap(),
        "http://127.0.0.1:7437"
    );
    assert_eq!(
        celestite_server::connection_base_url(Some("https://host/deploy///"), listen).unwrap(),
        "https://host/deploy"
    );
}

#[tokio::test]
async fn websocket_url_authenticates_before_upgrade_and_shutdown_closes_the_session() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    let f = Fixture::new();
    let server = f.start(HistoryMode::Initialize);
    let reader = server.links.key(Permission::Readonly).to_owned();
    let description = read(response(&server.router, &reader, "GET", "", Value::Null).await).await;
    let document = read(
        response(
            &server.router,
            &reader,
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
        uri(reader.trim_start_matches("ro-"), "")
    );
    assert!(
        matches!(connect_async(invalid).await.unwrap_err(), tokio_tungstenite::tungstenite::Error::Http(reply) if reply.status()==404)
    );
    let (mut socket, _) = connect_async(format!("ws://{address}{}/sync", uri(&reader, "")))
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
    server.shutdown.send_replace(true);
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

#[tokio::test]
async fn public_url_origin_is_allowed_for_the_hosted_client() {
    let f = Fixture::new();
    let mut config = f.config(HistoryMode::Initialize);
    config.server.public_url = Some("https://host.example/deploy".into());
    let server = build_server(config, f.dir.path()).unwrap();
    let key = server.links.key(Permission::Readonly);
    for (origin, expected) in [
        ("https://host.example", StatusCode::OK),
        ("https://other.example", StatusCode::FORBIDDEN),
    ] {
        let reply = server
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri(key, ""))
                    .header("origin", origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status(), expected);
    }
}
