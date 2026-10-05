use celestite_core::*;
use futures_lite::future::block_on;
use serde_json::json;
use std::cell::Cell;

thread_local! { static CLOCK: Cell<u64> = const { Cell::new(1000) }; }
fn time(now: u64) {
    CLOCK.with(|clock| clock.set(now));
}
fn now() -> u64 {
    CLOCK.with(Cell::get)
}

async fn core(path: &str, source: &str) -> EditorCore<MemoryBackend> {
    time(1000);
    let mut core = EditorCore::open(MemoryBackend::new(
        InstanceIdentity {
            instance_id: "instance".into(),
            vault: Vault {
                vault_id: "vault".into(),
                history_id: "vault-history".into(),
            },
        },
        now,
    ))
    .await
    .unwrap();
    let document = Document::new(
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: "history".into(),
        },
        Some(100),
        source,
    )
    .unwrap();
    core.join(path, document.export_snapshot().unwrap())
        .await
        .unwrap();
    core
}

async fn replace(core: &mut EditorCore<MemoryBackend>, text: &str) {
    let version = core.read("doc").unwrap().snapshot.version;
    core.execute_service(
        "replace_text",
        json!({"id":"doc", "version":version, "text":text}),
    )
    .await
    .unwrap();
}

fn output(task: &PreviewTask, html: &str) -> PreviewCompletion {
    PreviewCompletion {
        task_id: task.ticket.task_id.clone(),
        outcome: PreviewOutcome::Success {
            output: PreviewOutput {
                html: html.into(),
                diagnostics: vec![],
                source_map: vec![],
                used_components: vec![],
            },
        },
    }
}

fn sized_output(task: &PreviewTask, bytes: usize) -> PreviewCompletion {
    PreviewCompletion {
        task_id: task.ticket.task_id.clone(),
        outcome: PreviewOutcome::Success {
            output: PreviewOutput {
                html: "x".repeat(bytes),
                diagnostics: vec![],
                source_map: vec![],
                used_components: vec![],
            },
        },
    }
}

#[test]
fn oversized_output_fails_without_discarding_the_previous_preview() {
    block_on(async {
        let mut core = core("a.md", "old").await;
        core.subscribe_preview("doc", "client").unwrap();
        let old = core.take_preview_task("doc").unwrap().unwrap();
        core.complete_preview(output(&old, "previous"));
        replace(&mut core, "new").await;
        time(2000);
        let task = core.take_preview_task("doc").unwrap().unwrap();
        assert!(core.complete_preview(sized_output(&task, MAX_PREVIEW_OUTPUT_BYTES + 1)));
        let state = core.preview_state("doc").unwrap();
        assert_eq!(state.status, PreviewStatus::Failed);
        assert_eq!(state.result.unwrap().output.html, "previous");
        assert!(state.error.unwrap().contains("容量"));
    });
}

#[test]
fn cache_capacity_is_released_with_the_last_subscription() {
    block_on(async {
        let mut core = core("a.md", "small").await;
        let count = MAX_PREVIEW_CACHE_BYTES / MAX_PREVIEW_OUTPUT_BYTES;
        let mut first = None;
        for index in 0..=count {
            let id = if index == 0 {
                "doc".into()
            } else {
                let id = format!("cache-{index}");
                let document = Document::new(
                    DocumentIdentity {
                        document_id: id.clone(),
                        history_id: format!("history-{index}"),
                    },
                    Some(100),
                    "small",
                )
                .unwrap();
                core.join(&format!("{index}.md"), document.export_snapshot().unwrap())
                    .await
                    .unwrap();
                id
            };
            let subscription = core.subscribe_preview(&id, "client").unwrap();
            if index == 0 {
                first = Some(subscription.subscription_id);
            }
            let task = core.take_preview_task(&id).unwrap().unwrap();
            assert!(core.complete_preview(sized_output(&task, MAX_PREVIEW_OUTPUT_BYTES)));
            if index == count {
                assert_eq!(
                    core.preview_state(&id).unwrap().status,
                    PreviewStatus::Failed
                );
                assert!(core.unsubscribe_preview(&first.take().unwrap(), "client"));
                core.retry_preview(&id).unwrap();
                let task = core.take_preview_task(&id).unwrap().unwrap();
                assert!(core.complete_preview(sized_output(&task, MAX_PREVIEW_OUTPUT_BYTES)));
                assert_eq!(
                    core.preview_state(&id).unwrap().status,
                    PreviewStatus::Ready
                );
            }
        }
    });
}

#[test]
fn views_share_one_preview_and_client_cleanup_does_not_drop_another_view() {
    block_on(async {
        let mut core = core("a.md", "# Title").await;
        let a = core.subscribe_preview("doc", "client-a").unwrap();
        let b = core.subscribe_preview("doc", "client-b").unwrap();
        assert_eq!(a.state.target, b.state.target);
        assert_ne!(a.subscription_id, b.subscription_id);
        assert!(!core.unsubscribe_preview(&a.subscription_id, "client-b"));
        let task = core.take_preview_task("doc").unwrap().unwrap();
        assert!(core.take_preview_task("doc").unwrap().is_none());
        core.release_preview_client("client-a");
        assert!(core.complete_preview(output(&task, "<h1>Title</h1>")));
        assert_eq!(
            core.preview_state("doc").unwrap().status,
            PreviewStatus::Ready
        );
        core.release_preview_client("client-b");
        assert!(core.preview_state("doc").is_err());
        assert!(!core.complete_preview(output(&task, "late")));
        let reopened = core.subscribe_preview("doc", "client-b").unwrap();
        assert_ne!(reopened.state.target.session_id, a.state.target.session_id);
        assert!(reopened.state.result.is_none());
    });
}

#[test]
fn edits_coalesce_and_stale_or_unknown_completions_cannot_overwrite_current_state() {
    block_on(async {
        let mut core = core("a.md", "old").await;
        core.subscribe_preview("doc", "client").unwrap();
        let old = core.take_preview_task("doc").unwrap().unwrap();
        replace(&mut core, "middle").await;
        replace(&mut core, "latest 😀").await;
        let state = core.preview_state("doc").unwrap();
        assert_eq!(state.status, PreviewStatus::Pending);
        assert_eq!(
            state.target.version,
            core.read("doc").unwrap().snapshot.version
        );
        time(2000);
        assert!(core.take_preview_task("doc").unwrap().is_none());
        let mut unknown = output(&old, "incorrect");
        unknown.task_id = "unissued".into();
        assert!(!core.complete_preview(unknown));
        assert!(core.take_preview_task("doc").unwrap().is_none());
        assert!(!core.complete_preview(output(&old, "stale")));
        let latest = core.take_preview_task("doc").unwrap().unwrap();
        assert_eq!(latest.source, "latest 😀");
        assert_eq!(latest.ticket.version, state.target.version);
        assert_eq!(old.source, "old");
        assert!(core.complete_preview(output(&latest, "current")));
        assert!(!core.complete_preview(output(&old, "late")));
        assert!(!core.complete_preview(output(&latest, "duplicate")));
        assert_eq!(
            core.preview_state("doc")
                .unwrap()
                .result
                .unwrap()
                .output
                .html,
            "current"
        );
    });
}

#[test]
fn returning_to_same_text_by_undo_still_revokes_old_causal_version() {
    block_on(async {
        let mut core = core("a.md", "original").await;
        core.subscribe_preview("doc", "client").unwrap();
        let old = core.take_preview_task("doc").unwrap().unwrap();
        replace(&mut core, "changed").await;
        core.undo("doc", UndoContext::default(), false)
            .await
            .unwrap();
        let snapshot = core.read("doc").unwrap().snapshot;
        assert_eq!(snapshot.text, old.source);
        assert_ne!(snapshot.version, old.ticket.version);
        assert!(!core.complete_preview(output(&old, "obsolete")));
        time(2000);
        let task = core.take_preview_task("doc").unwrap().unwrap();
        core.undo("doc", UndoContext::default(), true)
            .await
            .unwrap();
        assert!(!core.complete_preview(output(&task, "obsolete after redo")));
        assert_eq!(core.read("doc").unwrap().snapshot.text, "changed");
    });
}

#[test]
fn imported_history_invalidates_preview_and_duplicate_import_does_not() {
    block_on(async {
        let mut core = core("a.md", "local").await;
        core.subscribe_preview("doc", "client").unwrap();
        let old = core.take_preview_task("doc").unwrap().unwrap();
        let mut peer = Document::from_snapshot(&core.snapshot("doc").unwrap(), Some(200)).unwrap();
        peer.transact(Transaction {
            expected_version: peer.version(),
            origin: "peer".into(),
            edits: vec![TextEdit {
                from: 5,
                to: 5,
                insert: " remote".into(),
            }],
            undo_metadata: None,
            undo_positions: vec![],
        })
        .unwrap();
        let packet = peer.export_updates_since(&old.ticket.version).unwrap();
        core.import("doc", packet.clone()).await.unwrap();
        assert!(!core.complete_preview(output(&old, "old")));
        time(2000);
        let task = core.take_preview_task("doc").unwrap().unwrap();
        core.import("doc", packet).await.unwrap();
        assert!(core.complete_preview(output(&task, "current")));
    });
}

#[test]
fn debounce_has_a_maximum_wait_and_does_not_enqueue_every_keystroke() {
    block_on(async {
        let mut core = core("a.md", "initial").await;
        core.subscribe_preview("doc", "client").unwrap();
        let initial = core.take_preview_task("doc").unwrap().unwrap();
        core.complete_preview(output(&initial, "initial"));
        replace(&mut core, "draft").await;
        assert_eq!(core.preview_state("doc").unwrap().due_at, Some(1120));
        assert!(core.take_preview_task("doc").unwrap().is_none());
        for i in 1..=5 {
            time(1000 + i * 100);
            replace(&mut core, &format!("draft {i}")).await;
        }
        let state = core.preview_state("doc").unwrap();
        assert_eq!(state.due_at, Some(1500));
        assert_eq!(state.result.unwrap().output.html, "initial");
        let task = core.take_preview_task("doc").unwrap().unwrap();
        assert_eq!(task.source, "draft 5");
        assert!(core.take_preview_task("doc").unwrap().is_none());
    });
}

#[test]
fn failure_preserves_last_output_and_explicit_retry_revokes_running_generation() {
    block_on(async {
        let mut core = core("a.md", "initial").await;
        core.subscribe_preview("doc", "client").unwrap();
        let initial = core.take_preview_task("doc").unwrap().unwrap();
        core.complete_preview(output(&initial, "last good"));
        replace(&mut core, "next").await;
        time(2000);
        let failed = core.take_preview_task("doc").unwrap().unwrap();
        assert!(core.complete_preview(PreviewCompletion {
            task_id: failed.ticket.task_id.clone(),
            outcome: PreviewOutcome::Failure {
                message: "worker failed".into(),
                diagnostics: vec![],
            },
        }));
        let state = core.preview_state("doc").unwrap();
        assert_eq!(state.status, PreviewStatus::Failed);
        assert_eq!(state.error.as_deref(), Some("worker failed"));
        assert_eq!(state.result.unwrap().output.html, "last good");
        assert!(core.take_preview_task("doc").unwrap().is_none());
        core.retry_preview("doc").unwrap();
        let first_retry = core.take_preview_task("doc").unwrap().unwrap();
        core.retry_preview("doc").unwrap();
        let second_retry = core.take_preview_task("doc").unwrap().unwrap();
        assert_ne!(
            first_retry.ticket.session_id,
            second_retry.ticket.session_id
        );
        assert!(!core.complete_preview(output(&first_retry, "revoked")));
        assert!(core.complete_preview(output(&second_retry, "recovered")));
    });
}

#[test]
fn event_delivery_coalesces_states_without_sequence_gaps_and_close_releases_preview() {
    block_on(async {
        let mut core = core("a.md", "initial").await;
        core.subscribe_preview("doc", "client").unwrap();
        assert_eq!(core.take_preview_events()[0].sequence, 1);
        assert!(core.take_preview_events().is_empty());
        let task = core.take_preview_task("doc").unwrap().unwrap();
        replace(&mut core, "a").await;
        replace(&mut core, "b").await;
        core.complete_preview(output(&task, "stale"));
        let events = core.take_preview_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].sequence, 2);
        assert_eq!(
            events[0].state.as_ref().unwrap().status,
            PreviewStatus::Pending
        );
        core.execute_service("close", json!({})).await.unwrap();
        let events = core.take_preview_events();
        assert_eq!(events[0].sequence, 3);
        assert!(events[0].state.is_none());
        assert!(core.take_preview_task("doc").unwrap().is_none());
        assert_eq!(core.read("doc").unwrap().snapshot.text, "b");
    });
}

#[test]
fn unsupported_documents_do_not_dispatch_and_json_contract_roundtrips() {
    block_on(async {
        let mut core = core("a.rs", "fn main() {}").await;
        let subscription: PreviewSubscription = serde_json::from_value(
            core.execute_service(
                "preview_subscribe",
                json!({"id":"doc", "clientSession":"client"}),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(subscription.state.status, PreviewStatus::Unsupported);
        assert!(core.take_preview_task("doc").unwrap().is_none());
        let result = core
            .execute_service("preview_complete", json!({"completion": {}}))
            .await;
        assert_eq!(result.unwrap_err().code, "InvalidPreview");
        assert_eq!(
            core.execute_service(
                "preview_unsubscribe",
                json!({
                    "subscriptionId":subscription.subscription_id, "clientSession":"client",
                })
            )
            .await
            .unwrap(),
            json!(true)
        );
        assert!(core.subscribe_preview("doc", "").is_err());
        for path in ["a.not", "a.md", "a.markdown", "folder/A.MD"] {
            assert!(supports_preview(path));
        }
        for path in ["a.rs", "a", "a.md.png"] {
            assert!(!supports_preview(path));
        }
    });
}

#[cfg(feature = "preview")]
#[test]
fn both_frontends_render_identical_escaped_output_without_mutating_core() {
    block_on(async {
        let mut not = core("a.not", "= Title\n\n*bold* `a < b`\n").await;
        let mut md = core("A.MARKDOWN", "# Title\n\n**bold** `a < b`\n").await;
        let mut results = Vec::new();
        for core in [&mut not, &mut md] {
            core.subscribe_preview("doc", "client").unwrap();
            let before = core.read("doc").unwrap();
            let task = core.take_preview_task("doc").unwrap().unwrap();
            let encoded = serde_json::to_string(&task).unwrap();
            let decoded: PreviewTask = serde_json::from_str(&encoded).unwrap();
            let result = compute_preview(&decoded);
            let result: PreviewCompletion =
                serde_json::from_str(&serde_json::to_string(&result).unwrap()).unwrap();
            assert!(core.complete_preview(result));
            let result = core.preview_state("doc").unwrap().result.unwrap().output;
            assert!(result.diagnostics.is_empty());
            assert_eq!(
                notist_html::Renderer::new().render(
                    notist::Pipeline::default()
                        .analyze(
                            task.ticket.path.to_lowercase(),
                            &task.source,
                            notist::builtins::registry()
                        )
                        .unwrap()
                        .root()
                ),
                "<section><h1>Title</h1><p><strong>bold</strong> <code>a &lt; b</code></p></section>"
            );
            assert!(!result.source_map.is_empty());
            let after = core.read("doc").unwrap();
            assert_eq!(before.snapshot, after.snapshot);
            assert_eq!(before.undo, after.undo);
            assert!(after.saved_version.is_none());
            results.push(result);
        }
        assert_eq!(results[0].html, results[1].html);
    });
}

#[cfg(feature = "preview")]
#[test]
fn source_maps_are_utf16_ranges_in_the_original_source_and_share_the_result_ticket() {
    block_on(async {
        for (path, source) in [
            (
                "a.md",
                "# 😀中文\n\nA &amp; B **bold**\n\n- item\n\n| X | Y |\n| --- | --- |\n| a | b |\n\n```rust\na < b\n```",
            ),
            (
                "a.not",
                "= 😀中文\n\nA \\* B *bold*\n\n- item\n\n| X | Y |\n| --- | --- |\n| a | b |\n\n```rust\na < b\n```\n\n#unknown[recovery]",
            ),
        ] {
            let mut core = core(path, source).await;
            core.subscribe_preview("doc", "client").unwrap();
            let task = core.take_preview_task("doc").unwrap().unwrap();
            assert!(core.complete_preview(compute_preview(&task)));
            let result = core.preview_state("doc").unwrap().result.unwrap();
            assert_eq!(result.ticket, task.ticket);
            let utf16: Vec<_> = source.encode_utf16().collect();
            let mut ids = std::collections::BTreeSet::new();
            for entry in &result.output.source_map {
                assert!(entry.from < entry.to && entry.to <= utf16.len());
                assert!(String::from_utf16(&utf16[entry.from..entry.to]).is_ok());
                assert!(ids.insert(entry.node_id));
                assert!(
                    result
                        .output
                        .html
                        .contains(&format!("data-notist-node=\"{}\"", entry.node_id))
                );
            }
            assert!(result.output.source_map.iter().any(|entry| {
                entry.kind == PreviewMappingKind::Inline
                    && String::from_utf16(&utf16[entry.from..entry.to]).unwrap() == "😀中文"
            }));
        }
    });
}

#[cfg(feature = "preview")]
#[test]
fn recovery_and_render_diagnostics_use_utf16_offsets_after_emoji_and_cjk() {
    block_on(async {
        let mut core = core("a.not", "😀中文 #unknown[ok]").await;
        core.subscribe_preview("doc", "client").unwrap();
        let task = core.take_preview_task("doc").unwrap().unwrap();
        assert!(core.complete_preview(compute_preview(&task)));
        let output = core.preview_state("doc").unwrap().result.unwrap().output;
        assert!(output.html.contains("notist-custom"));
        assert_eq!(output.diagnostics.len(), 2);
        for diagnostic in &output.diagnostics {
            assert_eq!((diagnostic.from, diagnostic.to), (5, 17));
            assert!(diagnostic.message.contains("unknown"));
        }
        assert_eq!(
            output.diagnostics[0].origin,
            PreviewDiagnosticOrigin::Analysis
        );
        assert_eq!(
            output.diagnostics[1].origin,
            PreviewDiagnosticOrigin::Render
        );
    });
}

#[test]
fn links_resolve_from_the_document_directory_and_cannot_escape_vault() {
    assert_eq!(
        resolve_preview_target("notes/a.not", "../b.md#中文").unwrap(),
        PreviewLink::Document {
            path: "b.md".into(),
            fragment: Some("中文".into())
        }
    );
    assert_eq!(
        resolve_preview_target("notes/a.not", "#hello%20world").unwrap(),
        PreviewLink::Fragment {
            fragment: "hello world".into()
        }
    );
    assert_eq!(
        resolve_preview_target("notes/a.not", "/root.md").unwrap(),
        PreviewLink::Document {
            path: "root.md".into(),
            fragment: None
        }
    );
    assert_eq!(
        resolve_preview_target("notes/a.not", "b%20c.md").unwrap(),
        PreviewLink::Document {
            path: "notes/b c.md".into(),
            fragment: None
        }
    );
    assert!(matches!(
        resolve_preview_target("a.md", "HTTPS://example.com").unwrap(),
        PreviewLink::External { .. }
    ));
    for target in [
        "../../escape.md",
        "%2e%2e/%2e%2e/escape.md",
        "java\nscript:bad",
        "data:text/html,bad",
        "a%5cb.md",
        "a%00.md",
        "a%ff.md",
        "a%z.md",
    ] {
        assert!(
            resolve_preview_target("notes/a.not", target).is_err(),
            "{target}"
        );
    }
    block_on(async {
        let mut core = core("notes/a.not", "[go](../b.md)").await;
        core.subscribe_preview("doc", "client").unwrap();
        let task = core.take_preview_task("doc").unwrap().unwrap();
        core.complete_preview(output(&task, "link"));
        assert!(
            core.preview_link("doc", &task.ticket.task_id, "../b.md")
                .is_ok()
        );
        replace(&mut core, "changed").await;
        assert_eq!(
            core.preview_link("doc", &task.ticket.task_id, "../b.md")
                .unwrap_err()
                .code,
            "StaleVersion"
        );
    });
}

#[cfg(feature = "preview")]
#[test]
fn packages_render_with_project_sources_and_cross_file_diagnostics() {
    block_on(async {
        let mut core = core("notes/a.not", "#widgets::badge(\"x\")[😀正文]").await;
        core.subscribe_preview("doc", "client").unwrap();
        let mut task = core.take_preview_task("doc").unwrap().unwrap();
        task.overlays.insert(
            "Notist.toml".into(),
            "[dependencies]\nwidgets = {path = 'packages/widgets'}".into(),
        );
        task.overlays.insert(
            "packages/widgets/lib.notc".into(),
            "fn badge(label: String)[children: InlineContent] -> InlineContent;".into(),
        );
        task.overlays.insert(
            "packages/widgets/Notist.toml".into(),
            "[package]\nname = 'widgets'\n".into(),
        );
        task.resources.insert(
            "notes/Notist.toml".into(),
            PreviewResource {
                kind: None,
                data: None,
                error: None,
            },
        );
        let requests = preview_resource_requests(&task);
        assert_eq!(requests.len(), 2);
        for request in requests {
            task.resources.insert(
                request.path.clone(),
                PreviewResource {
                    kind: request
                        .path
                        .ends_with("badge.js")
                        .then_some(PreviewResourceKind::File),
                    data: None,
                    error: None,
                },
            );
        }
        assert!(preview_resource_requests(&task).is_empty());
        let PreviewOutcome::Success { output } = compute_preview(&task).outcome else {
            panic!("package failed")
        };
        assert!(output.diagnostics.is_empty());
        assert!(output.html.contains("<widgets-badge"));
        assert_eq!(
            output.used_components[0].path,
            "packages/widgets/components/badge.js"
        );
        assert!(
            output
                .source_map
                .iter()
                .any(|entry| entry.to == task.source.encode_utf16().count())
        );
        let broken = "// 😀\nfn badge(label: Int = false) -> InlineContent;";
        task.overlays
            .insert("packages/widgets/lib.notc".into(), broken.into());
        let PreviewOutcome::Failure { diagnostics, .. } = compute_preview(&task).outcome else {
            panic!("bad declaration accepted")
        };
        assert!(!diagnostics.is_empty());
        for diagnostic in diagnostics {
            assert_eq!(diagnostic.path, "packages/widgets/lib.notc");
            assert_eq!(diagnostic.source.as_deref(), Some(broken));
            assert!(
                diagnostic.from < diagnostic.to && diagnostic.to <= broken.encode_utf16().count()
            );
        }
    });
}

#[test]
fn declaration_edits_and_file_changes_revoke_running_previews_without_body_edits() {
    block_on(async {
        let mut core = core("a.not", "= same body").await;
        core.subscribe_preview("doc", "client").unwrap();
        let old = core.take_preview_task("doc").unwrap().unwrap();
        let declaration = Document::new(
            DocumentIdentity {
                document_id: "defs".into(),
                history_id: "defs-history".into(),
            },
            Some(101),
            "fn leaf() -> Content;",
        )
        .unwrap();
        core.join(
            "packages/demo/lib.notc",
            declaration.export_snapshot().unwrap(),
        )
        .await
        .unwrap();
        assert!(!core.complete_preview(output(&old, "stale environment")));
        time(2000);
        let new = core.take_preview_task("doc").unwrap().unwrap();
        assert_eq!(old.ticket.version, new.ticket.version);
        assert_ne!(old.ticket.render_generation, new.ticket.render_generation);
        assert_eq!(
            new.overlays["packages/demo/lib.notc"],
            "fn leaf() -> Content;"
        );
        core.invalidate_preview_project();
        assert!(!core.complete_preview(output(&new, "stale file snapshot")));
    });
}

#[cfg(feature = "preview")]
#[test]
fn configured_transforms_preserve_unicode_mappings_and_report_transform_diagnostics() {
    block_on(async {
        let source = "😀 $x$ #math(false)";
        let mut core = core("math.not", source).await;
        core.subscribe_preview("doc", "client").unwrap();
        let mut task = core.take_preview_task("doc").unwrap().unwrap();
        let config = "future_option = true\n[dependencies]\nkatex = {path = 'packages/katex', future_option = true}\n[[transforms]]\nkind = 'replace'\nfrom = 'notist::math'\nto = 'katex::math'\nfuture_option = true\n";
        task.overlays.insert("Notist.toml".into(), config.into());
        task.overlays.insert(
            "packages/katex/Notist.toml".into(),
            "[package]\nname = 'katex'\n".into(),
        );
        task.overlays.insert(
            "packages/katex/lib.notc".into(),
            "fn math(text: String) -> InlineContent;".into(),
        );
        task.overlays.insert(
            "packages/katex/components/math.js".into(),
            "export default class extends HTMLElement {}".into(),
        );
        task.resources.insert(
            "packages/katex/components/math/index.js".into(),
            PreviewResource {
                kind: None,
                data: None,
                error: None,
            },
        );
        assert!(preview_resource_requests(&task).is_empty());
        let PreviewOutcome::Success { output } = compute_preview(&task).outcome else {
            panic!("transform config failed")
        };
        assert!(output.html.contains("<katex-math"));
        assert_eq!(output.used_components[0].package, "katex");
        assert!(
            output
                .source_map
                .iter()
                .any(|mapping| (mapping.from, mapping.to) == (3, 6))
        );
        let diagnostic = output
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.origin == PreviewDiagnosticOrigin::Transform)
            .expect("missing transform diagnostic");
        assert_eq!(diagnostic.path, "math.not");
        assert_eq!(
            (diagnostic.from, diagnostic.to),
            (7, source.encode_utf16().count())
        );
        assert!(diagnostic.source.is_none());
        assert!(diagnostic.message.contains("replace skipped"));
        // Known transform identities still produce source-bearing configuration errors.
        task.overlays.insert(
            "Notist.toml".into(),
            config.replace("katex::math", "missing::math"),
        );
        let PreviewOutcome::Failure { diagnostics, .. } = compute_preview(&task).outcome else {
            panic!("invalid transform accepted")
        };
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.path == "Notist.toml" && diagnostic.source.is_some())
        );
    });
}

#[cfg(feature = "preview")]
#[test]
fn resource_snapshots_support_sibling_and_absolute_packages_with_a_stable_document_root() {
    block_on(async {
        let mut core = core("a.not", "#widgets::badge(\"x\")[正文]").await;
        core.subscribe_preview("doc", "client").unwrap();
        let mut task = core.take_preview_task("doc").unwrap().unwrap();
        task.resource_root = "/workspace/docs".into();
        for dependency in ["../packages/widgets", "/workspace/packages/widgets"] {
            task.resources.clear();
            task.resources.insert(
                "/workspace/packages/widgets/Notist.toml".into(),
                PreviewResource {
                    kind: Some(PreviewResourceKind::File),
                    data: Some(b"[package]\nname = 'widgets'\n".to_vec()),
                    error: None,
                },
            );
            task.overlays.insert(
                "Notist.toml".into(),
                format!("[dependencies]\nwidgets = {{path = '{dependency}'}}"),
            );
            task.resources.insert(
                "/workspace/packages/widgets/lib.notc".into(),
                PreviewResource {
                    kind: Some(PreviewResourceKind::File),
                    data: Some(
                        b"fn badge(label: String)[children: InlineContent] -> InlineContent;"
                            .to_vec(),
                    ),
                    error: None,
                },
            );
            for request in preview_resource_requests(&task) {
                assert!(
                    request
                        .path
                        .starts_with("/workspace/packages/widgets/components/")
                );
                task.resources.insert(
                    request.path.clone(),
                    PreviewResource {
                        kind: request
                            .path
                            .ends_with("badge.js")
                            .then_some(PreviewResourceKind::File),
                        data: None,
                        error: None,
                    },
                );
            }
            assert!(preview_resource_requests(&task).is_empty());
            let PreviewOutcome::Success { output } = compute_preview(&task).outcome else {
                panic!("external package failed")
            };
            assert!(output.html.contains("<widgets-badge"));
            assert_eq!(
                output.used_components[0].package_root,
                "/workspace/packages/widgets"
            );
            assert_eq!(
                output.used_components[0].path,
                "/workspace/packages/widgets/components/badge.js"
            );
            assert_eq!(task.ticket.path, "a.not");
        }
    });
}
