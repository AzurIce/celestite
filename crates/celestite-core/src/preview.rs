//! Derived document previews. Scheduling policy lives here; platforms execute
//! immutable tasks separately from editing and persistence.
use crate::backend::{EditorError, EditorResult};
#[cfg(feature = "preview")]
use crate::editor::MAX_TEXT_BYTES;
use crate::editor::validate_editor_path;
use celestite_buffer::types::Version;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PREVIEW_DEBOUNCE_MS: u64 = 120;
pub const PREVIEW_MAX_WAIT_MS: u64 = 500;
pub const MAX_PREVIEW_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PREVIEW_CACHE_BYTES: usize = 64 * 1024 * 1024;

pub fn supports_preview(path: &str) -> bool {
    preview_extension(path).is_some()
}

fn preview_extension(path: &str) -> Option<String> {
    let extension = std::path::Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    matches!(extension.as_str(), "not" | "md" | "markdown").then_some(extension)
}

/// Only core issues tickets. The executor echoes task_id, never asserts which
/// document version its output belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewTicket {
    pub task_id: String,
    pub session_id: String,
    pub document_id: String,
    pub version: Version,
    pub path: String,
    pub render_generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewTask {
    pub ticket: PreviewTicket,
    pub source: String,
    #[serde(default)]
    pub overlays: BTreeMap<String, String>,
    #[serde(default)]
    pub resources: BTreeMap<String, PreviewResource>,
    #[serde(default = "default_resource_root")]
    pub resource_root: String,
}

fn default_resource_root() -> String {
    "/vault".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewResource {
    pub kind: Option<PreviewResourceKind>,
    pub data: Option<Vec<u8>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
pub enum PreviewResourceKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewResourceRequest {
    pub path: String,
    pub read: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewComponent {
    pub package: String,
    pub name: String,
    pub tag: String,
    pub path: String,
    pub package_root: String,
}

#[cfg(feature = "preview")]
pub mod project;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
pub enum PreviewDiagnosticOrigin {
    Analysis,
    Transform,
    Render,
    Environment,
}

/// Half-open UTF-16 offsets in the task's LF source, not the UI input projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewDiagnostic {
    pub from: usize,
    pub to: usize,
    pub origin: PreviewDiagnosticOrigin,
    pub phase: String,
    pub message: String,
    pub path: String,
    /// Only cross-file diagnostics carry their source, to verify navigation.
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewOutput {
    pub html: String,
    pub diagnostics: Vec<PreviewDiagnostic>,
    #[serde(default)]
    pub source_map: Vec<PreviewSourceMapping>,
    #[serde(default)]
    pub used_components: Vec<PreviewComponent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
pub enum PreviewMappingKind {
    Block,
    Inline,
    Container,
}

/// Output element ID scoped to the result ticket, with a half-open UTF-16 range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewSourceMapping {
    pub node_id: usize,
    pub from: usize,
    pub to: usize,
    pub kind: PreviewMappingKind,
}
fn diagnostic_bytes(diagnostics: &[PreviewDiagnostic]) -> usize {
    diagnostics.iter().fold(0usize, |size, diagnostic| {
        size.saturating_add(std::mem::size_of::<PreviewDiagnostic>())
            .saturating_add(diagnostic.message.len())
            .saturating_add(diagnostic.phase.len())
            .saturating_add(diagnostic.path.len())
            .saturating_add(diagnostic.source.as_ref().map_or(0, String::len))
    })
}
impl PreviewOutput {
    fn bytes(&self) -> usize {
        self.used_components.iter().fold(
            self.html
                .len()
                .saturating_add(
                    self.source_map
                        .len()
                        .saturating_mul(std::mem::size_of::<PreviewSourceMapping>()),
                )
                .saturating_add(diagnostic_bytes(&self.diagnostics)),
            |size, component| {
                size.saturating_add(std::mem::size_of::<PreviewComponent>())
                    .saturating_add(component.package.len())
                    .saturating_add(component.name.len())
                    .saturating_add(component.tag.len())
                    .saturating_add(component.path.len())
                    .saturating_add(component.package_root.len())
            },
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub enum PreviewOutcome {
    Success {
        output: PreviewOutput,
    },
    Failure {
        message: String,
        #[serde(default)]
        diagnostics: Vec<PreviewDiagnostic>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewCompletion {
    pub task_id: String,
    pub outcome: PreviewOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewResult {
    pub ticket: PreviewTicket,
    pub output: PreviewOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
pub enum PreviewStatus {
    Unsupported,
    Pending,
    Computing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewState {
    pub target: PreviewTicket,
    pub status: PreviewStatus,
    pub result: Option<PreviewResult>,
    pub error: Option<String>,
    pub diagnostics: Vec<PreviewDiagnostic>,
    /// Deadline on the Backend clock. None while the current target is running
    /// or awaiting retry. An older running task can still delay dispatch.
    pub due_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewSubscription {
    pub subscription_id: String,
    pub state: PreviewState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct PreviewEvent {
    pub sequence: u64,
    pub document_id: String,
    /// None closes this preview session; it does not close document history.
    pub state: Option<PreviewState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub enum PreviewLink {
    Fragment {
        fragment: String,
    },
    Document {
        path: String,
        fragment: Option<String>,
    },
    External {
        url: String,
    },
}

/// Interpret renderer URLs within a Vault, independently of browser location.
pub fn resolve_preview_target(path: &str, target: &str) -> EditorResult<PreviewLink> {
    let invalid = || {
        EditorError::new(
            "InvalidPath",
            "Invalid preview link or path outside Vault",
            path,
        )
    };
    let target: String = target
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let target = target.trim_matches(|c: char| c <= '\u{20}');
    let prefix = target.split(['/', '\\', '?', '#']).next().unwrap_or("");
    if let Some((scheme, _)) = prefix.split_once(':') {
        if !["https", "http", "mailto", "tel", "ftp"]
            .iter()
            .any(|s| scheme.eq_ignore_ascii_case(s))
        {
            return Err(invalid());
        }
        return Ok(PreviewLink::External { url: target.into() });
    }
    if target.starts_with("//") {
        return Ok(PreviewLink::External { url: target.into() });
    }
    fn decode(value: &str) -> Option<String> {
        let mut bytes = Vec::new();
        let mut input = value.bytes();
        while let Some(byte) = input.next() {
            bytes.push(if byte == b'%' {
                let hex = [input.next()?, input.next()?];
                u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?
            } else {
                byte
            });
        }
        String::from_utf8(bytes).ok()
    }
    let (target_path, fragment) = target
        .split_once('#')
        .map_or((target, None), |(p, f)| (p, Some(f)));
    let fragment = fragment
        .map(|f| decode(f).ok_or_else(invalid))
        .transpose()?;
    if target_path.is_empty() {
        return Ok(PreviewLink::Fragment {
            fragment: fragment.unwrap_or_default(),
        });
    }
    if target_path.contains('?') {
        return Err(invalid());
    }
    let decoded = decode(target_path).ok_or_else(invalid)?;
    if decoded.contains(['\\', '\0']) {
        return Err(invalid());
    }
    let parent = path.rsplit_once('/').map_or("", |(p, _)| p);
    let mut segments: Vec<_> = if decoded.starts_with('/') {
        vec![]
    } else {
        parent.split('/').filter(|s| !s.is_empty()).collect()
    };
    for segment in decoded.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err(invalid());
                }
            }
            segment => segments.push(segment),
        }
    }
    let path = segments.join("/");
    validate_editor_path(&path)?;
    if path.is_empty() {
        return Err(invalid());
    }
    Ok(PreviewLink::Document { path, fragment })
}

/// Pure synchronous computation. Run in a dedicated Worker / CPU task, never
/// synchronously in an edit or save command. No IO or CRDT writes occur here.
#[cfg(feature = "preview")]
pub fn compute_preview(task: &PreviewTask) -> PreviewCompletion {
    let mut environment_diagnostics = Vec::new();
    let computed = (|| -> EditorResult<PreviewOutput> {
        if task.source.len() > MAX_TEXT_BYTES || task.source.contains('\r') {
            return Err(EditorError::new(
                "InvalidPreview",
                "Preview requires bounded LF source",
                &task.ticket.path,
            ));
        }
        let extension = preview_extension(&task.ticket.path).ok_or_else(|| {
            EditorError::new(
                "Unsupported",
                "Unsupported preview format",
                &task.ticket.path,
            )
        })?;
        // Frontend selection is case-sensitive; the logical path remains in
        // the ticket for resource resolution, while dispatch uses a canonical ext.
        let resources = project::SnapshotResources::new(task);
        let mut vault = notist::Vault::new(resources);
        let path = std::path::Path::new(&task.ticket.path).with_extension(extension);
        let computed = vault
            .render_html(&path, &task.source, notist::RenderOptions::default())
            .map_err(|error| {
                if let notist::VaultError::Environment(errors) = &error {
                    environment_diagnostics = errors
                        .iter()
                        .map(|error| PreviewDiagnostic {
                            from: error.source[..usize::from(error.diagnostic.span.start())]
                                .encode_utf16()
                                .count(),
                            to: error.source[..usize::from(error.diagnostic.span.end())]
                                .encode_utf16()
                                .count(),
                            origin: PreviewDiagnosticOrigin::Environment,
                            phase: error.diagnostic.phase.to_string(),
                            message: error.diagnostic.message.clone(),
                            path: project::resource_key(&task.resource_root, &error.path),
                            source: Some(error.source.clone()),
                        })
                        .collect();
                }
                EditorError::new("InvalidPreview", error.to_string(), &task.ticket.path)
            })?;
        let analysis = computed.analysis;
        let transformed = computed.transformed;
        let rendered = computed.rendered;
        let environment = vault.environment_for(&path).map_err(|error| {
            EditorError::new("InvalidPreview", error.to_string(), &task.ticket.path)
        })?;
        let used_components = rendered
            .used_components
            .iter()
            .filter_map(|component| {
                Some(PreviewComponent {
                    package: component.id.package.clone(),
                    name: component.id.name.clone(),
                    tag: component.tag.clone(),
                    path: project::resource_key(&task.resource_root, component.module.resource()?),
                    package_root: project::resource_key(
                        &task.resource_root,
                        &environment.packages()[&component.id.package].root,
                    ),
                })
            })
            .collect();
        let raw_diagnostics: Vec<_> = analysis
            .diagnostics()
            .iter()
            .map(|diagnostic| (PreviewDiagnosticOrigin::Analysis, diagnostic))
            .chain(
                transformed
                    .diagnostics
                    .iter()
                    .map(|diagnostic| (PreviewDiagnosticOrigin::Transform, diagnostic)),
            )
            .chain(
                rendered
                    .diagnostics
                    .iter()
                    .map(|diagnostic| (PreviewDiagnosticOrigin::Render, diagnostic)),
            )
            .collect();
        // Walk source once for all requested boundaries. Counting each prefix
        // separately would become quadratic on a document with many errors.
        let mut offsets: Vec<_> = raw_diagnostics
            .iter()
            .flat_map(|(_, diagnostic)| {
                [
                    usize::from(diagnostic.span.start()),
                    usize::from(diagnostic.span.end()),
                ]
            })
            .chain(
                rendered
                    .source_map
                    .iter()
                    .flat_map(|entry| [entry.range.start, entry.range.end]),
            )
            .collect();
        offsets.sort_unstable();
        offsets.dedup();
        let mut units = Vec::with_capacity(offsets.len());
        let mut chars = task.source.chars();
        let (mut byte, mut utf16) = (0, 0);
        for &offset in &offsets {
            while byte < offset {
                let Some(character) = chars.next() else {
                    return Err(EditorError::new(
                        "InvalidPreview",
                        "Preview mapping exceeds source",
                        &task.ticket.path,
                    ));
                };
                byte += character.len_utf8();
                utf16 += character.len_utf16();
            }
            if byte != offset {
                return Err(EditorError::new(
                    "InvalidPreview",
                    "Preview mapping splits a Unicode scalar",
                    &task.ticket.path,
                ));
            }
            units.push(utf16);
        }
        let diagnostics = raw_diagnostics
            .into_iter()
            .map(|(origin, diagnostic)| {
                let from = usize::from(diagnostic.span.start());
                let to = usize::from(diagnostic.span.end());
                PreviewDiagnostic {
                    from: units[offsets.binary_search(&from).unwrap()],
                    to: units[offsets.binary_search(&to).unwrap()],
                    origin,
                    phase: diagnostic.phase.to_string(),
                    message: diagnostic.message.clone(),
                    path: task.ticket.path.clone(),
                    source: None,
                }
            })
            .collect();
        let output = PreviewOutput {
            html: rendered.html,
            used_components,
            diagnostics,
            source_map: rendered
                .source_map
                .into_iter()
                .map(|entry| PreviewSourceMapping {
                    node_id: entry.node_id,
                    from: units[offsets.binary_search(&entry.range.start).unwrap()],
                    to: units[offsets.binary_search(&entry.range.end).unwrap()],
                    kind: match entry.kind {
                        notist_html::SourceMappingKind::Block => PreviewMappingKind::Block,
                        notist_html::SourceMappingKind::Inline => PreviewMappingKind::Inline,
                        notist_html::SourceMappingKind::Container => PreviewMappingKind::Container,
                    },
                })
                .collect(),
        };
        if output.bytes() > MAX_PREVIEW_OUTPUT_BYTES {
            return Err(EditorError::new(
                "PreviewLimit",
                "预览内容超过容量，请缩小文档。",
                &task.ticket.path,
            ));
        }
        Ok(output)
    })();
    PreviewCompletion {
        task_id: task.ticket.task_id.clone(),
        outcome: match computed {
            Ok(output) => PreviewOutcome::Success { output },
            Err(error) => PreviewOutcome::Failure {
                message: error.message,
                diagnostics: environment_diagnostics,
            },
        },
    }
}

pub mod sessions;
