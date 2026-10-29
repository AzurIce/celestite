//! Notist language service: an independent read-only consumer of accepted
//! document text. Hosts deliver JSON-RPC messages and answer resource
//! requests; the service performs no IO and owns no editor state.
//!
//! Open document URIs use `file:///vault/{key}` independently of the host's
//! actual resource root. The service computes against an immutable resource
//! snapshot; missing snapshots pause pending work until the host answers
//! `provide`.
use crate::fs::validate_path;
use crate::preview::manifests::ManifestSource;
use crate::preview::paths::{ResourceNamespace, ResourcePath};
use crate::preview::{
    PreviewResource, PreviewResourceKind, PreviewResourceRequest, ResourceContext,
};
use lsp_types::{
    Diagnostic, DiagnosticSeverity, DocumentSymbol, Hover, HoverContents, MarkupContent,
    MarkupKind, Position, Range, SymbolKind,
};
use notist::{Ctor, Item, ResourceError, Resources, Value, resources::ResourceKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;
const SERVER_NOT_INITIALIZED: i64 = -32002;

/// Outcome of a host call: messages to deliver to the client, plus resource
/// reads the host must answer before pending work can continue.
/// The host delivers messages before answering any resource requests.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct LanguageStep {
    pub messages: Vec<String>,
    pub resource_requests: Vec<PreviewResourceRequest>,
    pub context: Option<ResourceContext>,
}

/// Resource answers for [`LanguageService::provide`]; keys echo the requested
/// paths. A present entry with `kind: null` confirms absence.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct LanguageResources {
    #[serde(default)]
    pub resources: BTreeMap<String, PreviewResource>,
}

enum Pending {
    Refresh,
    Request {
        id: Json,
        kind: RequestKind,
        params: PositionParams,
    },
}

#[derive(Debug, Clone, Copy)]
enum RequestKind {
    Hover,
    Definition,
    Symbols,
}

/// A stateful Notist LSP endpoint over headerless JSON-RPC messages.
pub struct LanguageService {
    namespace: ResourceNamespace,
    /// Open documents keyed by the client's raw URI string.
    documents: BTreeMap<String, String>,
    versions: BTreeMap<String, i64>,
    reported: BTreeSet<String>,
    store: BTreeMap<String, PreviewResource>,
    /// Asked (path, read) pairs; a kind probe must not mask the later read of
    /// the same path, and an unanswered pair must not loop forever.
    asked: BTreeSet<(String, bool)>,
    manifests: RefCell<BTreeMap<PathBuf, ManifestSource>>,
    requests: RefCell<BTreeMap<String, bool>>,
    pending: VecDeque<Pending>,
    running: bool,
    shutdown: bool,
}

impl LanguageService {
    pub fn new(root: &str) -> Self {
        Self::with_namespace(ResourceNamespace::new(root))
    }

    /// Native hosts use real paths so configured command extensions run in
    /// their actual project directory. Browser hosts keep the executor
    /// namespace, where Notist reports process extensions as unavailable.
    #[cfg(all(feature = "native", not(target_arch = "wasm32")))]
    pub fn native(root: &str) -> Self {
        Self::with_namespace(ResourceNamespace::native(root))
    }

    fn with_namespace(namespace: ResourceNamespace) -> Self {
        Self {
            namespace,
            documents: BTreeMap::new(),
            versions: BTreeMap::new(),
            reported: BTreeSet::new(),
            store: BTreeMap::new(),
            asked: BTreeSet::new(),
            manifests: RefCell::new(BTreeMap::new()),
            requests: RefCell::new(BTreeMap::new()),
            pending: VecDeque::new(),
            running: false,
            shutdown: false,
        }
    }

    pub fn handle(&mut self, message: &str) -> LanguageStep {
        match serde_json::from_str::<Incoming>(message) {
            Ok(incoming) => self.dispatch(incoming),
            Err(error) => LanguageStep {
                messages: vec![error_response(Json::Null, PARSE_ERROR, error.to_string())],
                ..Default::default()
            },
        }
    }

    /// Merge answered resources and resume pending work.
    pub fn provide(&mut self, resources: LanguageResources) -> LanguageStep {
        self.store.extend(resources.resources);
        self.run_pending()
    }

    /// Drop all snapshot answers; the next operation re-requests them.
    pub fn invalidate_resources(&mut self) {
        self.store.clear();
        self.asked.clear();
        self.manifests.borrow_mut().clear();
    }

    fn dispatch(&mut self, incoming: Incoming) -> LanguageStep {
        let Incoming { id, method, params } = incoming;
        let Some(id) = id else {
            return self.notify(&method, params);
        };
        if method == "initialize" {
            self.running = true;
            return step_with(response(id, initialize_result()));
        }
        if !self.running {
            return step_with(error_response(
                id,
                SERVER_NOT_INITIALIZED,
                "language service is not initialized",
            ));
        }
        if self.shutdown {
            return step_with(error_response(
                id,
                INVALID_REQUEST,
                "language service is shut down",
            ));
        }
        match method.as_str() {
            "shutdown" => {
                self.shutdown = true;
                step_with(response(id, Json::Null))
            }
            "textDocument/hover" => self.enqueue(id, params, RequestKind::Hover),
            "textDocument/definition" => self.enqueue(id, params, RequestKind::Definition),
            "textDocument/documentSymbol" => self.enqueue(id, params, RequestKind::Symbols),
            _ => step_with(error_response(
                id,
                METHOD_NOT_FOUND,
                format!("unsupported method {method}"),
            )),
        }
    }

    fn notify(&mut self, method: &str, params: Json) -> LanguageStep {
        if !self.running || self.shutdown {
            return LanguageStep::default();
        }
        match method {
            "textDocument/didOpen" => {
                let Some(params) = parse::<DidOpenParams>(params) else {
                    return LanguageStep::default();
                };
                let document = params.text_document;
                if self.key_for(&document.uri).is_none()
                    || self
                        .versions
                        .get(&document.uri)
                        .is_some_and(|version| *version >= document.version)
                {
                    return LanguageStep::default();
                }
                self.versions.insert(document.uri.clone(), document.version);
                self.documents.insert(document.uri, document.text);
                self.push_refresh();
                self.run_pending()
            }
            "textDocument/didChange" => {
                let Some(params) = parse::<DidChangeParams>(params) else {
                    return LanguageStep::default();
                };
                let Some(change) = params.content_changes.into_iter().last() else {
                    return LanguageStep::default();
                };
                let document = params.text_document;
                if !self.documents.contains_key(&document.uri)
                    || self
                        .versions
                        .get(&document.uri)
                        .is_some_and(|version| *version >= document.version)
                {
                    return LanguageStep::default();
                }
                self.versions.insert(document.uri.clone(), document.version);
                self.documents.insert(document.uri, change.text);
                self.push_refresh();
                self.run_pending()
            }
            "textDocument/didClose" => {
                let Some(params) = parse::<DidCloseParams>(params) else {
                    return LanguageStep::default();
                };
                let uri = params.text_document.uri;
                self.documents.remove(&uri);
                self.versions.remove(&uri);
                self.push_refresh();
                let mut step = self.run_pending();
                step.messages.insert(
                    0,
                    notification(
                        "textDocument/publishDiagnostics",
                        json!({ "uri": uri, "diagnostics": [] }),
                    ),
                );
                step
            }
            "workspace/didChangeWatchedFiles" => {
                self.invalidate_resources();
                self.push_refresh();
                self.run_pending()
            }
            _ => LanguageStep::default(),
        }
    }

    fn push_refresh(&mut self) {
        if !self
            .pending
            .iter()
            .any(|pending| matches!(pending, Pending::Refresh))
        {
            self.pending.push_back(Pending::Refresh);
        }
    }

    fn enqueue(&mut self, id: Json, params: Json, kind: RequestKind) -> LanguageStep {
        match serde_json::from_value::<PositionParams>(params) {
            Ok(params) => {
                self.pending
                    .push_back(Pending::Request { id, kind, params });
                self.run_pending()
            }
            Err(error) => step_with(error_response(id, INVALID_PARAMS, error.to_string())),
        }
    }

    fn run_pending(&mut self) -> LanguageStep {
        let mut step = LanguageStep::default();
        while let Some(pending) = self.pending.pop_front() {
            self.requests.borrow_mut().clear();
            let output = match &pending {
                Pending::Refresh => {
                    let (messages, reported) = self.refresh();
                    PendingOutput::Refresh { messages, reported }
                }
                Pending::Request { id, kind, params } => {
                    PendingOutput::Messages(vec![self.answer(id, *kind, params)])
                }
            };
            let recorded: Vec<PreviewResourceRequest> =
                std::mem::take(&mut *self.requests.borrow_mut())
                    .into_iter()
                    .map(|(path, read)| PreviewResourceRequest { path, read })
                    .collect();
            if recorded.is_empty() {
                match output {
                    PendingOutput::Refresh { messages, reported } => {
                        self.reported = reported;
                        step.messages.extend(messages);
                    }
                    PendingOutput::Messages(messages) => step.messages.extend(messages),
                }
                continue;
            }
            if recorded
                .iter()
                .all(|request| self.asked.contains(&(request.path.clone(), request.read)))
            {
                // The host never answered these paths; do not loop forever.
                if let Pending::Request { id, .. } = &pending {
                    step.messages.push(error_response(
                        id.clone(),
                        INTERNAL_ERROR,
                        format!(
                            "language resources unavailable: {}",
                            recorded
                                .iter()
                                .map(|request| request.path.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    ));
                }
                continue;
            }
            self.asked.extend(
                recorded
                    .iter()
                    .map(|request| (request.path.clone(), request.read)),
            );
            step.resource_requests = recorded;
            step.context = self.resource_context();
            self.pending.push_front(pending);
            break;
        }
        step
    }

    fn answer(&self, id: &Json, kind: RequestKind, params: &PositionParams) -> String {
        match kind {
            RequestKind::Hover => response(id.clone(), self.hover(params)),
            RequestKind::Definition => response(id.clone(), self.definition(params)),
            RequestKind::Symbols => response(id.clone(), self.symbols(params)),
        }
    }

    fn key_for(&self, uri: &str) -> Option<String> {
        let key = uri.strip_prefix("file:///vault/")?;
        validate_path(key).ok()?;
        (!key.is_empty()).then(|| key.to_owned())
    }

    fn uri_for(&self, key: &str) -> String {
        if key.starts_with('/') {
            format!("file://{key}")
        } else if key.as_bytes().get(1) == Some(&b':') {
            format!("file:///{key}")
        } else {
            format!("file:///vault/{key}")
        }
    }

    fn resource_context(&self) -> Option<ResourceContext> {
        let mut sources = self
            .documents
            .iter()
            .filter_map(|(uri, source)| Some((self.key_for(uri)?, source.clone())));
        let (document_path, source) = sources.next()?;
        let mut overlays = self
            .store
            .iter()
            .filter_map(|(path, resource)| {
                if path != "Notist.toml" && !path.ends_with("/Notist.toml") {
                    return None;
                }
                Some((
                    path.clone(),
                    String::from_utf8(resource.data.clone()?).ok()?,
                ))
            })
            .collect::<BTreeMap<_, _>>();
        overlays.extend(sources);
        Some(ResourceContext {
            document_path,
            source,
            overlays,
        })
    }

    fn with_resources<T>(&self, operation: impl FnOnce(&StoreResources<'_>) -> T) -> T {
        let overlays: BTreeMap<String, &str> = self
            .documents
            .iter()
            .filter_map(|(uri, text)| Some((self.key_for(uri)?, text.as_str())))
            .collect();
        let resources = StoreResources {
            namespace: &self.namespace,
            overlays: &overlays,
            store: &self.store,
            manifests: &self.manifests,
            requests: &self.requests,
        };
        operation(&resources)
    }

    fn refresh(&self) -> (Vec<String>, BTreeSet<String>) {
        self.with_resources(|resources| {
            let mut vault = notist::Vault::new(resources);
            let mut published: BTreeMap<String, Vec<Diagnostic>> = BTreeMap::new();
            for uri in self.documents.keys().chain(self.reported.iter()) {
                published.entry(uri.clone()).or_default();
            }
            // Source texts for cross-file range mapping, keyed by the module
            // identities diagnostics carry.
            let mut sources: notist::Sources = self
                .documents
                .iter()
                .filter_map(|(uri, source)| {
                    let key = self.key_for(uri)?;
                    let path = self.namespace.resolve(Path::new(&key));
                    Some((path.to_string_lossy().into_owned(), source.as_str().into()))
                })
                .collect();
            let mut pending: Vec<(String, notist::Diagnostic)> = Vec::new();
            for (uri, source) in &self.documents {
                let Some(key) = self.key_for(uri) else {
                    continue;
                };
                let path = self.namespace.resolve(Path::new(&key));
                if key.ends_with(".notc") {
                    match vault.analyze_code(&path, source) {
                        Ok(analysis) => {
                            sources.extend(analysis.sources.clone());
                            pending.extend(
                                analysis
                                    .diagnostics
                                    .into_iter()
                                    .map(|diagnostic| (uri.clone(), diagnostic)),
                            );
                        }
                        Err(error) => self.route_vault_error(&mut published, uri, source, error),
                    }
                    continue;
                }
                if key.ends_with("Notist.toml") {
                    if let Err(diagnostics) = notist::environment::parse_config(source) {
                        pending.extend(
                            diagnostics
                                .into_iter()
                                .map(|diagnostic| (uri.clone(), diagnostic)),
                        );
                    }
                    continue;
                }
                match vault.analyze(&path, source) {
                    Ok(analysis) => {
                        sources.extend(analysis.sources().clone());
                        pending.extend(
                            analysis
                                .into_parts()
                                .1
                                .into_iter()
                                .map(|diagnostic| (uri.clone(), diagnostic)),
                        );
                    }
                    Err(error) => self.route_vault_error(&mut published, uri, source, error),
                }
            }
            for (uri, diagnostic) in pending {
                let target = diagnostic
                    .source
                    .as_deref()
                    .map(|path| self.uri_for(&self.namespace.key(Path::new(path))))
                    .unwrap_or_else(|| uri.clone());
                let text = diagnostic
                    .source
                    .as_deref()
                    .and_then(|path| sources.get(path))
                    .map(AsRef::as_ref)
                    .or_else(|| self.documents.get(&target).map(String::as_str))
                    .or_else(|| self.documents.get(&uri).map(String::as_str));
                let Some(text) = text else {
                    continue;
                };
                published
                    .entry(target)
                    .or_default()
                    .push(lsp_diagnostic(text, &diagnostic));
            }
            for diagnostics in published.values_mut() {
                let mut unique = Vec::new();
                for diagnostic in diagnostics.drain(..) {
                    if !unique.contains(&diagnostic) {
                        unique.push(diagnostic);
                    }
                }
                *diagnostics = unique;
            }
            let reported: BTreeSet<String> = published
                .iter()
                .filter(|(_, diagnostics)| !diagnostics.is_empty())
                .map(|(uri, _)| uri.clone())
                .collect();
            let messages = published
                .into_iter()
                .map(|(uri, diagnostics)| {
                    let mut params = json!({ "uri": uri, "diagnostics": diagnostics });
                    if let Some(version) = self.versions.get(&uri) {
                        params["version"] = json!(version);
                    }
                    notification("textDocument/publishDiagnostics", params)
                })
                .collect();
            (messages, reported)
        })
    }

    /// Environment and resource failures bypass the usual source attribution;
    /// environment diagnostics carry their own source snapshot.
    fn route_vault_error(
        &self,
        published: &mut BTreeMap<String, Vec<Diagnostic>>,
        uri: &str,
        source: &str,
        error: notist::VaultError,
    ) {
        match error {
            notist::VaultError::Environment(errors) => {
                for error in &errors {
                    let (target, diagnostic) = self.environment_diagnostic(error);
                    published.entry(target).or_default().push(diagnostic);
                }
                published
                    .entry(uri.into())
                    .or_default()
                    .push(lsp_diagnostic(
                        source,
                        &notist::Diagnostic::new(
                            notist::Phase::Semantic,
                            Default::default(),
                            "source imports or output configuration are invalid",
                        ),
                    ));
            }
            notist::VaultError::Unsupported(_) => {}
            notist::VaultError::Resource(error) => {
                published.entry(uri.into()).or_default().push(Diagnostic {
                    range: Range::default(),
                    severity: Some(DiagnosticSeverity::ERROR),
                    source: Some("notist:resource".into()),
                    message: self.namespace.message(&error.to_string()),
                    ..Default::default()
                });
            }
        }
    }

    /// Map an environment failure to its owning document URI and an LSP
    /// diagnostic; rewritten manifest ranges are mapped back to the original.
    fn environment_diagnostic(&self, error: &notist::SourceDiagnostic) -> (String, Diagnostic) {
        let resolved = self.namespace.resolve(&error.path);
        let manifests = self.manifests.borrow();
        let prepared = manifests
            .get(&resolved)
            .filter(|prepared| prepared.analysis == error.source);
        let from = usize::from(error.diagnostic.span.start());
        let to = usize::from(error.diagnostic.span.end());
        let source = prepared.map_or_else(
            || error.source.clone(),
            |prepared| prepared.original.clone(),
        );
        let range = from..to;
        let lines = LineIndex::new(&source);
        (
            self.uri_for(&self.namespace.key(&error.path)),
            Diagnostic {
                range: Range::new(
                    lines.position(&source, range.start),
                    lines.position(&source, range.end),
                ),
                severity: Some(DiagnosticSeverity::ERROR),
                source: Some(format!("notist:{}", error.diagnostic.phase)),
                message: self.namespace.message(&error.diagnostic.message),
                ..Default::default()
            },
        )
    }

    fn hover(&self, params: &PositionParams) -> Option<Hover> {
        let uri = &params.text_document.uri;
        let key = self.key_for(uri)?;
        let source = self.documents.get(uri)?.clone();
        let lines = LineIndex::new(&source);
        let offset = lines.offset(&source, params.position);
        if key.ends_with(".notc") {
            let parse = notist::syntax::code::parse_module(
                &source,
                &notist::syntax::markup::MarkupContentParser,
            );
            let module = notist::syntax::code::ast::Module::cast(parse.syntax())?;
            let target = module
                .functions()
                .find(|function| function.range().contains((offset as u32).into()))?;
            return Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::PlainText,
                    value: target.syntax().text().to_string(),
                }),
                range: Some(lines.range(&source, target.range())),
            });
        }
        self.with_resources(|resources| {
            let mut vault = notist::Vault::new(resources);
            let path = self.namespace.resolve(Path::new(&key));
            let item = vault.analyze(&path, &source).ok()?.into_parts().0;
            if let Some(name) = call_path_at(&key, &source, offset)
                && let Ok(project) = vault.environment_for(&path, &source)
                && let Some(definition) = project.context().resolve(&name)
            {
                return Some(Hover {
                    contents: HoverContents::Markup(MarkupContent {
                        kind: MarkupKind::PlainText,
                        value: project
                            .modules()
                            .get(&definition.id.module)
                            .and_then(|module| {
                                module.source.get(
                                    usize::from(definition.span.start())
                                        ..usize::from(definition.span.end()),
                                )
                            })
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                format!(
                                    "{}({}) -> {:?}",
                                    definition.id,
                                    definition
                                        .parameters
                                        .iter()
                                        .map(|parameter| format!(
                                            "{}: {}",
                                            parameter.name, parameter.ty
                                        ))
                                        .collect::<Vec<_>>()
                                        .join(", "),
                                    definition
                                        .returns
                                        .level()
                                        .unwrap_or(notist::builtins::Level::Inherit)
                                )
                            }),
                    }),
                    range: None,
                });
            }
            let target = smallest_at(&item, offset)?;
            Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: hover_text(target),
                }),
                range: Some(lines.range(&source, target.span)),
            })
        })
    }

    fn definition(&self, params: &PositionParams) -> Option<Json> {
        let uri = &params.text_document.uri;
        let key = self.key_for(uri)?;
        let source = self.documents.get(uri)?.clone();
        let lines = LineIndex::new(&source);
        let offset = lines.offset(&source, params.position);
        self.with_resources(|resources| {
            let mut vault = notist::Vault::new(resources);
            let path = self.namespace.resolve(Path::new(&key));
            let item = vault.analyze(&path, &source).ok()?.into_parts().0;
            if let Some(name) = call_path_at(&key, &source, offset) {
                let project = vault.environment_for(&path, &source).ok()?;
                let definition = project.context().resolve(&name)?;
                let module = project.modules().get(&definition.id.module)?;
                let engine = project
                    .context()
                    .program()
                    .source_path(&definition.id.module)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| module.path.clone());
                let target = self.namespace.key(&engine);
                return Some(json!({
                    "uri": self.uri_for(&target),
                    "range": LineIndex::new(&module.source).range(&module.source, definition.span),
                }));
            }
            // A caption's text and inline formatting are children of the
            // link. Definition targets its nearest enclosing link rather
            // than the leaf that hover describes.
            let target = item
                .descendants()
                .filter(|item| {
                    item.ctor == Ctor::Link && item.span.contains((offset as u32).into())
                })
                .min_by_key(|item| item.span.len())?;
            let Some(Value::Str(target_text)) = target.fields.get("target") else {
                return None;
            };
            if let Some(item_id) = target_text.strip_prefix('#') {
                let index = notist::index::Index::build(&item, &mut Vec::new());
                let span = index.by_id(item_id)?;
                return Some(json!({ "uri": uri, "range": lines.range(&source, span) }));
            }
            if target_text.contains("://") {
                return None;
            }
            let path_part = target_text.split('#').next().unwrap_or("");
            let target = self.namespace.path(&path).parent().resolve(path_part);
            Some(json!({
                "uri": self.uri_for(&self.namespace.key(&target.engine())),
                "range": Range::default(),
            }))
        })
    }

    fn symbols(&self, params: &PositionParams) -> Option<Json> {
        let uri = &params.text_document.uri;
        let key = self.key_for(uri)?;
        let source = self.documents.get(uri)?.clone();
        let lines = LineIndex::new(&source);
        if key.ends_with(".notc") {
            let parse = notist::syntax::code::parse_module(
                &source,
                &notist::syntax::markup::MarkupContentParser,
            );
            let module = notist::syntax::code::ast::Module::cast(parse.syntax())?;
            let symbols = module
                .functions()
                .filter_map(|function| {
                    #[allow(deprecated)]
                    Some(DocumentSymbol {
                        name: function.name()?.text().into(),
                        detail: None,
                        kind: SymbolKind::FUNCTION,
                        tags: None,
                        deprecated: None,
                        range: lines.range(&source, function.range()),
                        selection_range: lines.range(&source, function.range()),
                        children: None,
                    })
                })
                .collect::<Vec<_>>();
            return serde_json::to_value(symbols).ok();
        }
        self.with_resources(|resources| {
            let mut vault = notist::Vault::new(resources);
            let path = self.namespace.resolve(Path::new(&key));
            let item = vault.analyze(&path, &source).ok()?.into_parts().0;
            let symbols = item
                .children
                .iter()
                .filter_map(|item| symbol(item, &lines, &source))
                .collect::<Vec<_>>();
            serde_json::to_value(symbols).ok()
        })
    }
}

enum PendingOutput {
    Refresh {
        messages: Vec<String>,
        reported: BTreeSet<String>,
    },
    Messages(Vec<String>),
}

fn step_with(message: String) -> LanguageStep {
    LanguageStep {
        messages: vec![message],
        ..Default::default()
    }
}

fn parse<T: for<'a> Deserialize<'a>>(params: Json) -> Option<T> {
    serde_json::from_value(params).ok()
}

fn response(id: Json, result: impl Serialize) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_response(id: Json, code: i64, message: impl Into<String>) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
        .to_string()
}

fn notification(method: &str, params: Json) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

fn initialize_result() -> Json {
    let capabilities = lsp_types::ServerCapabilities {
        text_document_sync: Some(lsp_types::TextDocumentSyncCapability::Kind(
            lsp_types::TextDocumentSyncKind::FULL,
        )),
        document_symbol_provider: Some(lsp_types::OneOf::Left(true)),
        hover_provider: Some(lsp_types::HoverProviderCapability::Simple(true)),
        definition_provider: Some(lsp_types::OneOf::Left(true)),
        ..Default::default()
    };
    json!({
        "capabilities": capabilities,
        "serverInfo": { "name": "celestite-notist" },
    })
}

/// Unsatisfied snapshot reads are recorded here and reported after each run.
struct StoreResources<'a> {
    namespace: &'a ResourceNamespace,
    overlays: &'a BTreeMap<String, &'a str>,
    store: &'a BTreeMap<String, PreviewResource>,
    manifests: &'a RefCell<BTreeMap<PathBuf, ManifestSource>>,
    requests: &'a RefCell<BTreeMap<String, bool>>,
}

impl StoreResources<'_> {
    fn request(&self, path: &str, read: bool) {
        self.requests
            .borrow_mut()
            .entry(path.into())
            .and_modify(|value| *value |= read)
            .or_insert(read);
    }

    fn key(&self, path: &Path) -> Result<String, ResourceError> {
        let key = self.namespace.key(path);
        if ResourcePath::absolute(&key).is_none() {
            validate_path(&key).map_err(|error| ResourceError::Access {
                path: PathBuf::from(&key),
                message: error.message,
            })?;
        }
        Ok(key)
    }
}

impl Resources for StoreResources<'_> {
    fn root(&self) -> &Path {
        self.namespace.root()
    }
    fn resolve(&self, path: &Path) -> PathBuf {
        self.namespace.resolve(path)
    }
    fn kind(&self, path: &Path) -> Result<Option<ResourceKind>, ResourceError> {
        let resolved = self.resolve(path);
        // Configuration discovery may probe ancestors; never expose other roots.
        if !resolved.starts_with(self.root())
            && resolved
                .file_name()
                .is_some_and(|name| name == "Notist.toml")
        {
            return Ok(None);
        }
        let key = self.key(path)?;
        if key.is_empty() {
            return Ok(Some(ResourceKind::Directory));
        }
        if self.overlays.contains_key(&key) {
            return Ok(Some(ResourceKind::File));
        }
        if self
            .overlays
            .keys()
            .any(|overlay| overlay.starts_with(&format!("{key}/")))
        {
            return Ok(Some(ResourceKind::Directory));
        }
        match self.store.get(&key) {
            Some(resource) => {
                if let Some(message) = &resource.error {
                    return Err(ResourceError::Access {
                        path: PathBuf::from(&key),
                        message: message.clone(),
                    });
                }
                Ok(resource.kind.map(|kind| match kind {
                    PreviewResourceKind::File => ResourceKind::File,
                    PreviewResourceKind::Directory => ResourceKind::Directory,
                }))
            }
            None => {
                self.request(&key, false);
                Ok(None)
            }
        }
    }
    fn read(&self, path: &Path) -> Result<Vec<u8>, ResourceError> {
        let key = self.key(path)?;
        if let Some(source) = self.overlays.get(&key) {
            return Ok(source.as_bytes().to_vec());
        }
        if let Some(resource) = self.store.get(&key) {
            if let Some(message) = &resource.error {
                return Err(ResourceError::Access {
                    path: PathBuf::from(&key),
                    message: message.clone(),
                });
            }
            if let Some(data) = &resource.data {
                return Ok(data.clone());
            }
            if resource.kind.is_none() {
                return Err(ResourceError::NotFound(PathBuf::from(&key)));
            }
        }
        self.request(&key, true);
        Err(ResourceError::Access {
            path: PathBuf::from(&key),
            message: "resource snapshot is not prepared".into(),
        })
    }
    fn source(&self, path: &Path) -> Result<String, ResourceError> {
        let source = String::from_utf8(self.read(path)?)
            .map_err(|_| ResourceError::InvalidUtf8(PathBuf::from(self.namespace.key(path))))?;
        let source = source
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        let resolved = self.resolve(path);
        if resolved
            .file_name()
            .is_some_and(|name| name == "Notist.toml")
        {
            let prepared = ManifestSource::new(source, false);
            let analysis = prepared.analysis.clone();
            self.manifests.borrow_mut().insert(resolved, prepared);
            Ok(analysis)
        } else {
            Ok(source)
        }
    }
    fn entries(&self, _path: &Path) -> Result<Vec<PathBuf>, ResourceError> {
        Ok(vec![])
    }
}

#[derive(Deserialize)]
struct Incoming {
    #[serde(default)]
    id: Option<Json>,
    method: String,
    #[serde(default)]
    params: Json,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDocumentItem {
    uri: String,
    version: i64,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDocumentRef {
    uri: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidOpenParams {
    text_document: TextDocumentItem,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidChangeParams {
    text_document: VersionedDocumentRef,
    #[serde(default)]
    content_changes: Vec<TextChange>,
}

#[derive(Deserialize)]
struct VersionedDocumentRef {
    uri: String,
    version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextChange {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidCloseParams {
    text_document: TextDocumentRef,
}

/// Hover, definition and documentSymbol share this envelope; symbols leave
/// position at its default.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionParams {
    text_document: TextDocumentRef,
    #[serde(default)]
    position: Position,
}

/// The smallest item whose span contains `offset`.
fn smallest_at(item: &Item, offset: usize) -> Option<&Item> {
    for child in &item.children {
        if child.span.contains(notist::TextSize::from(offset as u32)) {
            return Some(smallest_at(child, offset).unwrap_or(child));
        }
    }
    None
}

fn hover_text(item: &Item) -> String {
    let mut out = format!(
        "`{}` ({:?})",
        item.ctor
            .function_id()
            .map(|id| id.to_string())
            .unwrap_or_else(|| item.ctor.name().into_owned()),
        item.level
    );
    for (k, v) in item.fields.iter() {
        out.push_str(&format!("\n- `{k}` = {v}"));
    }
    for (k, v) in item.attrs.iter() {
        out.push_str(&format!("\n- `@{k}` = {v}"));
    }
    out
}

/// A heading → a symbol; sections nest. Section names are their heading text.
fn symbol(item: &Item, lines: &LineIndex, src: &str) -> Option<DocumentSymbol> {
    let (name, range, selection, children) = match item.ctor {
        Ctor::Section => {
            let heading = item.children.first()?;
            let name = text_of(heading);
            (
                name,
                lines.range(src, item.span),
                lines.range(src, heading.span),
                item.children[1..]
                    .iter()
                    .filter_map(|c| symbol(c, lines, src))
                    .collect(),
            )
        }
        Ctor::Heading => (
            text_of(item),
            lines.range(src, item.span),
            lines.range(src, item.span),
            Vec::new(),
        ),
        _ => return None,
    };
    #[allow(deprecated)]
    Some(DocumentSymbol {
        name,
        detail: None,
        kind: SymbolKind::NAMESPACE,
        tags: None,
        deprecated: None,
        range,
        selection_range: selection,
        children: Some(children),
    })
}

/// The text content of a heading: its children's text fields, joined.
fn text_of(item: &Item) -> String {
    match item.fields.get("text") {
        Some(Value::Str(text)) => text.to_owned(),
        _ => item.children.iter().map(text_of).collect(),
    }
}

fn call_path_at(key: &str, source: &str, offset: usize) -> Option<String> {
    if !key.ends_with(".not") {
        return None;
    }
    notist::syntax::markup::parse_document(source)
        .syntax()
        .descendants()
        .filter_map(notist::syntax::code::ast::CodeCall::cast)
        .find_map(|call| {
            let path = call.callee()?;
            path.text_range()
                .contains((offset as u32).into())
                .then(|| path.text().to_string())
        })
}

fn lsp_diagnostic(source: &str, diagnostic: &notist::Diagnostic) -> Diagnostic {
    Diagnostic {
        range: LineIndex::new(source).range(source, diagnostic.span),
        severity: Some(DiagnosticSeverity::ERROR),
        source: Some(format!("notist:{}", diagnostic.phase)),
        message: diagnostic.message.clone(),
        ..Default::default()
    }
}

/// Byte offset ↔ LSP position (line + UTF-16 column).
struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(src: &str) -> Self {
        let mut starts = vec![0];
        for (i, b) in src.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        Self { starts }
    }

    fn position(&self, src: &str, offset: usize) -> Position {
        let mut offset = offset.min(src.len());
        while !src.is_char_boundary(offset) {
            offset -= 1;
        }
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        let col = src[self.starts[line]..offset]
            .chars()
            .map(|c| c.len_utf16())
            .sum::<usize>();
        Position::new(line as u32, col as u32)
    }

    fn offset(&self, src: &str, position: Position) -> usize {
        let line = (position.line as usize).min(self.starts.len() - 1);
        let start = self.starts[line];
        let end = self.starts.get(line + 1).copied().unwrap_or(src.len());
        let mut col = 0usize;
        for (i, c) in src[start..end].char_indices() {
            if col >= position.character as usize {
                return start + i;
            }
            col += c.len_utf16();
        }
        end
    }

    fn range(&self, src: &str, span: notist::TextRange) -> Range {
        Range::new(
            self.position(src, usize::from(span.start())),
            self.position(src, usize::from(span.end())),
        )
    }
}
