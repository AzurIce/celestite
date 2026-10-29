#![cfg(feature = "language")]

use celestite_core::language::{LanguageResources, LanguageService};
use celestite_core::preview::PreviewResource;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Drive handle/provide rounds until no resource requests remain; every
/// requested path is answered as absent unless `fill` provides it.
fn run(service: &mut LanguageService, message: Value) -> Vec<Value> {
    run_with(service, message, &BTreeMap::new())
}

fn run_with(
    service: &mut LanguageService,
    message: Value,
    fill: &BTreeMap<String, PreviewResource>,
) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut step = service.handle(&message.to_string());
    loop {
        messages.extend(
            step.messages
                .iter()
                .map(|message| serde_json::from_str(message).unwrap()),
        );
        if step.resource_requests.is_empty() {
            return messages;
        }
        let mut resources = BTreeMap::new();
        for request in &step.resource_requests {
            let resource = fill.get(&request.path).cloned().unwrap_or(PreviewResource {
                kind: None,
                data: None,
                error: None,
            });
            resources.insert(request.path.clone(), resource);
        }
        step = service.provide(LanguageResources { resources });
    }
}

fn file(data: &str) -> PreviewResource {
    PreviewResource {
        kind: Some(celestite_core::preview::PreviewResourceKind::File),
        data: Some(data.as_bytes().to_vec()),
        error: None,
    }
}

fn initialize(service: &mut LanguageService) {
    let messages = run(
        service,
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
    );
    assert_eq!(
        messages.len(),
        1,
        "initialize produces exactly one response"
    );
    assert_eq!(messages[0]["id"], 1);
}

fn open(service: &mut LanguageService, uri: &str, text: &str) -> Vec<Value> {
    run(
        service,
        json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": uri, "version": 1, "text": text } }
        }),
    )
}

fn diagnostics_for<'a>(messages: &'a [Value], uri: &str) -> Option<&'a Vec<Value>> {
    messages.iter().find_map(|message| {
        if message["method"] == "textDocument/publishDiagnostics" && message["params"]["uri"] == uri
        {
            message["params"]["diagnostics"].as_array()
        } else {
            None
        }
    })
}

#[test]
fn initialize_advertises_capabilities() {
    let mut service = LanguageService::new("/vault");
    let messages = run(
        &mut service,
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
    );
    let capabilities = &messages[0]["result"]["capabilities"];
    assert_eq!(capabilities["textDocumentSync"], 1);
    assert_eq!(capabilities["hoverProvider"], true);
    assert_eq!(capabilities["definitionProvider"], true);
    assert_eq!(capabilities["documentSymbolProvider"], true);
    assert_eq!(
        messages[0]["result"]["serverInfo"]["name"],
        "celestite-notist"
    );
}

#[test]
fn requests_before_initialize_are_rejected() {
    let mut service = LanguageService::new("/vault");
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 7, "method": "textDocument/hover",
            "params": { "textDocument": { "uri": "file:///vault/a.not" }, "position": {"line": 0, "character": 0} }
        }),
    );
    assert_eq!(messages[0]["error"]["code"], -32002);
}

#[test]
fn unknown_methods_are_rejected() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let messages = run(
        &mut service,
        json!({"jsonrpc": "2.0", "id": 2, "method": "textDocument/rename", "params": {}}),
    );
    assert_eq!(messages[0]["error"]["code"], -32601);
    let messages = service.handle("not json at all");
    let messages = [serde_json::from_str::<Value>(&messages.messages[0]).unwrap()];
    assert_eq!(messages[0]["error"]["code"], -32700);
}

#[test]
fn broken_notc_reports_and_clears_diagnostics() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/pkg/lib.notc";
    let messages = open(&mut service, uri, "fn broken(\n");
    let diagnostics = diagnostics_for(&messages, uri).expect("publish diagnostics");
    assert!(
        !diagnostics.is_empty(),
        "parse errors must be reported: {diagnostics:?}"
    );
    assert_eq!(diagnostics[0]["severity"], 1);

    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": {
                "textDocument": { "uri": uri, "version": 2 },
                "contentChanges": [{ "text": "fn panel(title: String) -> BlockContent;\n" }]
            }
        }),
    );
    let diagnostics = diagnostics_for(&messages, uri).expect("cleared diagnostics");
    assert!(diagnostics.is_empty(), "valid module clears diagnostics");
}

#[test]
fn document_symbols_list_markdown_headings() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/notes/a.md";
    open(&mut service, uri, "# 标题\n\n正文\n\n## 小节\n\n更多\n");
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "textDocument/documentSymbol",
            "params": { "textDocument": { "uri": uri } }
        }),
    );
    assert_eq!(messages[0]["id"], 3);
    let symbols = messages[0]["result"].as_array().expect("symbol list");
    assert_eq!(symbols[0]["name"], "标题");
    let children = symbols[0]["children"].as_array().expect("nested symbols");
    assert_eq!(children[0]["name"], "小节");
}

#[test]
fn hover_on_markup_item_shows_ctor() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/notes/a.not";
    open(&mut service, uri, "= 标题\n\n正文 *强调* 结束\n");
    // "正文 *强调* 结束": 强 sits at UTF-16 column 4.
    let character = 4;
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 4, "method": "textDocument/hover",
            "params": { "textDocument": { "uri": uri }, "position": { "line": 2, "character": character } }
        }),
    );
    let result = &messages[0]["result"];
    assert!(!result.is_null(), "emphasis hover exists");
    let value = result["contents"]["value"].as_str().unwrap();
    assert!(
        value.contains("notist."),
        "hover names the resolved ctor: {value}"
    );
}

#[test]
fn goto_definition_resolves_links() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/notes/a.not";
    open(
        &mut service,
        uri,
        "@(id: \"target\")\n= 目标\n\n[链接](#target) 与 [其他](b.not)\n",
    );
    // Links live on line 3; character 4 sits inside `#target`.
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 5, "method": "textDocument/definition",
            "params": { "textDocument": { "uri": uri }, "position": { "line": 3, "character": 4 } }
        }),
    );
    let result = &messages[0]["result"];
    assert_eq!(result["uri"], uri, "#id stays in the same document");
    assert!(
        result["range"]["start"]["line"].is_number(),
        "in-document target carries a range: {result}"
    );

    // "[链接](#target) 与 [其他](b.not)": `b.not` spans UTF-16 columns 21..26.
    let character = 23;
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 6, "method": "textDocument/definition",
            "params": { "textDocument": { "uri": uri }, "position": { "line": 3, "character": character } }
        }),
    );
    assert_eq!(
        messages[0]["result"]["uri"], "file:///vault/notes/b.not",
        "relative links resolve against the document directory"
    );
}

#[test]
fn goto_definition_resolves_plain_and_formatted_link_captions_in_utf16() {
    for (extension, caption) in [
        ("not", "链接"),
        ("md", "链接"),
        ("not", "*粗体 _嵌套_* `代码`"),
        ("md", "**粗体 _嵌套_** `代码`"),
    ] {
        let mut service = LanguageService::new("/vault");
        initialize(&mut service);
        let uri = format!("file:///vault/notes/a.{extension}");
        let source = format!("😀 [{caption}](b.not) tail\n");
        open(&mut service, &uri, &source);
        let label_start = source.find('[').unwrap();
        let label_end = source.find(']').unwrap();
        // Include both caption delimiters and every UTF-8 character boundary
        // inside nested formatting. The prefix emoji occupies two UTF-16 units.
        for (offset, _) in source[..=label_end].char_indices() {
            if offset < label_start {
                continue;
            }
            let character = source[..offset].encode_utf16().count();
            let messages = run(
                &mut service,
                json!({
                    "jsonrpc": "2.0", "id": 10, "method": "textDocument/definition",
                    "params": {
                        "textDocument": { "uri": uri },
                        "position": { "line": 0, "character": character }
                    }
                }),
            );
            assert_eq!(
                messages[0]["result"]["uri"], "file:///vault/notes/b.not",
                "caption offset {character} in {uri}: {source}"
            );
        }
        for offset in [label_start - 1, source.find(") tail").unwrap() + 1] {
            let messages = run(
                &mut service,
                json!({
                    "jsonrpc": "2.0", "id": 11, "method": "textDocument/definition",
                    "params": {
                        "textDocument": { "uri": uri },
                        "position": {
                            "line": 0, "character": source[..offset].encode_utf16().count()
                        }
                    }
                }),
            );
            assert!(
                messages[0]["result"].is_null(),
                "positions outside the link must not navigate: {messages:?}"
            );
        }
    }
}

#[test]
fn module_environments_load_through_resource_rounds() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/a.not";
    let text = "#import \"../widgets/lib.notc\" as widgets;\n\n#widgets.panel(\"标题\")\n";
    let mut messages = Vec::new();
    let mut step = service.handle(
        &json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": uri, "version": 1, "text": text } }
        })
        .to_string(),
    );
    // Import graph and config probes must be requested before diagnostics.
    assert!(
        !step.resource_requests.is_empty(),
        "first analysis requests resource probes"
    );
    let fill: BTreeMap<String, PreviewResource> = [(
        "/widgets/lib.notc".into(),
        file("fn panel(title: String) -> BlockContent;\n"),
    )]
    .into_iter()
    .collect();
    loop {
        messages.extend(
            step.messages
                .iter()
                .map(|message| serde_json::from_str::<Value>(message).unwrap()),
        );
        if step.resource_requests.is_empty() {
            break;
        }
        let mut resources = BTreeMap::new();
        for request in &step.resource_requests {
            let resource = fill.get(&request.path).cloned().unwrap_or(PreviewResource {
                kind: None,
                data: None,
                error: None,
            });
            resources.insert(request.path.clone(), resource);
        }
        step = service.provide(LanguageResources { resources });
    }
    let diagnostics = diagnostics_for(&messages, uri).expect("publish diagnostics");
    assert!(
        diagnostics.is_empty(),
        "imported calls analyze cleanly: {diagnostics:?}"
    );

    // Hover on the call path shows the declaration source.
    let character = "#widgets.panel".find("panel").unwrap() + 1;
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 8, "method": "textDocument/hover",
            "params": { "textDocument": { "uri": uri }, "position": { "line": 2, "character": character } }
        }),
    );
    let value = messages[0]["result"]["contents"]["value"]
        .as_str()
        .expect("hover contents");
    assert!(
        value.contains("panel"),
        "hover shows the declaration: {value}"
    );

    // Definition jumps to the module declaration.
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 9, "method": "textDocument/definition",
            "params": { "textDocument": { "uri": uri }, "position": { "line": 2, "character": character } }
        }),
    );
    let result = &messages[0]["result"];
    assert_eq!(result["uri"], "file:///widgets/lib.notc");
}

#[test]
fn kind_probes_do_not_mask_later_reads_of_the_same_path() {
    // An honest host answers a kind probe (read=false) without data; the read
    // escalation that follows must still be requested, not dropped as "asked".
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/a.not";
    let text = "#import \"../widgets/lib.notc\" as widgets;\n\n#widgets.panel(\"标题\")\n";
    let mut messages = Vec::new();
    let mut step = service.handle(
        &json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": uri, "version": 1, "text": text } }
        })
        .to_string(),
    );
    let fill: BTreeMap<String, PreviewResource> = [(
        "/widgets/lib.notc".into(),
        file("fn panel(title: String) -> BlockContent;\n"),
    )]
    .into_iter()
    .collect();
    let mut rounds = 0;
    loop {
        rounds += 1;
        assert!(rounds < 20, "resource rounds must terminate");
        messages.extend(
            step.messages
                .iter()
                .map(|message| serde_json::from_str::<Value>(message).unwrap()),
        );
        if step.resource_requests.is_empty() {
            break;
        }
        let mut resources = BTreeMap::new();
        for request in &step.resource_requests {
            let resource = match fill.get(&request.path) {
                Some(resource) if request.read => resource.clone(),
                Some(resource) => PreviewResource {
                    data: None,
                    ..resource.clone()
                },
                None => PreviewResource {
                    kind: None,
                    data: None,
                    error: None,
                },
            };
            resources.insert(request.path.clone(), resource);
        }
        step = service.provide(LanguageResources { resources });
    }
    let diagnostics = diagnostics_for(&messages, uri).expect("publish diagnostics");
    assert!(
        diagnostics.is_empty(),
        "declared calls analyze cleanly: {diagnostics:?}"
    );
    let character = "#widgets.panel".find("panel").unwrap() + 1;
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0", "id": 8, "method": "textDocument/hover",
            "params": { "textDocument": { "uri": uri }, "position": { "line": 2, "character": character } }
        }),
    );
    assert!(
        messages[0]["result"]["contents"]["value"]
            .as_str()
            .expect("hover contents")
            .contains("panel"),
        "hover reads the declaration after kind probes: {messages:?}"
    );
}

#[test]
fn close_clears_diagnostics() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/pkg/lib.notc";
    open(&mut service, uri, "fn broken(\n");
    let messages = run(
        &mut service,
        json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didClose",
            "params": { "textDocument": { "uri": uri } }
        }),
    );
    let diagnostics = diagnostics_for(&messages, uri).expect("close publishes a clear");
    assert!(diagnostics.is_empty());
}

#[test]
fn diagnostics_echo_the_source_version_and_ignore_older_changes() {
    let mut service = LanguageService::new("/vault");
    initialize(&mut service);
    let uri = "file:///vault/lib.notc";
    let messages = run(
        &mut service,
        json!({
            "method":"textDocument/didOpen",
            "params":{"textDocument":{"uri":uri,"version":7,"text":"fn broken("}}
        }),
    );
    let published = messages.iter().find(|m| m["params"]["uri"] == uri).unwrap();
    assert_eq!(published["params"]["version"], 7);
    assert!(
        !published["params"]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let messages = run(
        &mut service,
        json!({
            "method":"textDocument/didChange",
            "params":{"textDocument":{"uri":uri,"version":8},"contentChanges":[{"text":"fn panel() -> BlockContent;"}]}
        }),
    );
    assert_eq!(messages[0]["params"]["version"], 8);
    assert_eq!(messages[0]["params"]["diagnostics"], json!([]));
    for version in [6, 8] {
        let messages = run(
            &mut service,
            json!({
                "method":"textDocument/didChange",
                "params":{"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":"fn broken("}]}
            }),
        );
        assert!(messages.is_empty(), "stale changes produce no diagnostics");
    }
    let symbols = run(
        &mut service,
        json!({"id":9,"method":"textDocument/documentSymbol","params":{"textDocument":{"uri":uri}}}),
    );
    assert_eq!(symbols[0]["result"][0]["name"], "panel");
}

#[test]
fn logical_document_uris_resolve_against_the_real_resource_root() {
    let mut service = LanguageService::new("/workspace/project/vault");
    initialize(&mut service);
    let uri = "file:///vault/notes/a.not";
    let other = "= Other open source\n";
    open(&mut service, "file:///vault/z.not", other);
    let source = "#import \"../../../widgets/lib.notc\" as widgets;\n\n#widgets.panel()\n";
    let step = service.handle(&json!({"method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"version":1,"text":source}}}).to_string());
    let context = step
        .context
        .expect("resource requests include source roots");
    assert_eq!(context.document_path, "notes/a.not");
    assert_eq!(context.source, source);
    assert_eq!(context.overlays["z.not"], other);
    assert!(
        step.resource_requests
            .iter()
            .any(|request| request.path == "/workspace/widgets/lib.notc"),
        "multi-level imports retain the real root depth"
    );
    // Complete the pending operation with a real external declaration.
    let fill: BTreeMap<String, PreviewResource> = BTreeMap::from([(
        "/workspace/widgets/lib.notc".into(),
        file("fn panel() -> BlockContent;"),
    )]);
    let mut step = service.provide(LanguageResources {
        resources: step
            .resource_requests
            .into_iter()
            .map(|request| {
                let value = fill.get(&request.path).cloned().unwrap_or(PreviewResource {
                    kind: None,
                    data: None,
                    error: None,
                });
                (request.path, value)
            })
            .collect(),
    });
    while !step.resource_requests.is_empty() {
        step = service.provide(LanguageResources {
            resources: step
                .resource_requests
                .into_iter()
                .map(|request| {
                    let value = fill.get(&request.path).cloned().unwrap_or(PreviewResource {
                        kind: None,
                        data: None,
                        error: None,
                    });
                    (request.path, value)
                })
                .collect(),
        });
    }
    assert!(
        diagnostics_for(
            &step
                .messages
                .iter()
                .map(|m| serde_json::from_str(m).unwrap())
                .collect::<Vec<_>>(),
            uri
        )
        .unwrap()
        .is_empty()
    );
    let definition = run(
        &mut service,
        json!({"id":4,"method":"textDocument/definition","params":{"textDocument":{"uri":uri},"position":{"line":2,"character":11}}}),
    );
    assert_eq!(
        definition[0]["result"]["uri"],
        "file:///workspace/widgets/lib.notc"
    );
}

#[test]
fn symbols_keep_formatted_heading_text_for_all_markdown_extensions() {
    for extension in ["md", "markdown", "nmd", "notmd"] {
        let mut service = LanguageService::new("/vault");
        initialize(&mut service);
        let uri = format!("file:///vault/a.{extension}");
        open(&mut service, &uri, "# 标题 *强调* `code`\n");
        let messages = run(
            &mut service,
            json!({"id":2,"method":"textDocument/documentSymbol","params":{"textDocument":{"uri":uri}}}),
        );
        assert_eq!(
            messages[0]["result"][0]["name"], "标题 强调 code",
            "{extension}"
        );
    }
}

#[cfg(all(feature = "native", not(target_arch = "wasm32"), unix))]
#[test]
fn native_language_service_runs_command_extensions_in_the_real_configuration_directory() {
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().canonicalize().unwrap();
    std::fs::write(
        root.join("ext.sh"),
        "#!/bin/sh\ncat >/dev/null\n: > ran\nprintf '{\"version\":1}'\n",
    )
    .unwrap();
    let config =
        "[[extensions]]\nkind = 'command'\ncommand = ['sh', 'ext.sh']\nstages = ['after_check']\n";
    let mut service = LanguageService::native(root.to_str().unwrap());
    initialize(&mut service);
    let fill = BTreeMap::from([("Notist.toml".to_owned(), file(config))]);
    let messages = run_with(
        &mut service,
        json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": "file:///vault/a.not", "version": 1, "text": "正文\n" } }
        }),
        &fill,
    );
    assert!(root.join("ran").exists(), "command extension did not run");
    assert!(
        messages
            .iter()
            .all(|message| message["method"] != "window/showMessage"),
        "{messages:?}"
    );
}
