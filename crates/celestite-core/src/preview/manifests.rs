//! Immutable configuration snapshots. Document imports are relative to the
//! configuration and resolved by Notist's resource host, so the source is
//! normally passed through unchanged. Native resource discovery removes
//! process extensions: discovery must not run user code or spawn processes,
//! and a later replace rule still needs its module graph.
pub(crate) struct ManifestSource {
    pub(crate) original: String,
    pub(crate) analysis: String,
}

impl ManifestSource {
    pub(crate) fn new(original: String, strip_commands: bool) -> Self {
        let analysis = if strip_commands {
            without_commands(&original).unwrap_or_else(|| original.clone())
        } else {
            original.clone()
        };
        Self { original, analysis }
    }
}

fn without_commands(source: &str) -> Option<String> {
    let mut value = source.parse::<toml::Value>().ok()?;
    let extensions = value.get_mut("extensions")?.as_array_mut()?;
    let before = extensions.len();
    extensions
        .retain(|extension| extension.get("kind").and_then(toml::Value::as_str) != Some("command"));
    if extensions.len() == before {
        return None;
    }
    if extensions.is_empty() {
        value.as_table_mut()?.remove("extensions");
    }
    toml::to_string(&value).ok()
}

#[cfg(test)]
mod tests {
    use super::{ManifestSource, without_commands};

    const REPLACE: &str = "[[extensions]]\nkind = 'replace'\nimports = { katex = '../modules/katex/lib.notc' }\nfrom = 'notist.math'\nto = 'katex.math'\n";

    #[test]
    fn extension_imports_remain_relative_and_unchanged() {
        let source = ManifestSource::new(REPLACE.into(), false);
        assert_eq!(source.analysis, source.original);
        let parsed = notist::environment::parse_config(&source.analysis).unwrap();
        let import = &parsed.extensions[0].imports()[0];
        assert_eq!(
            &source.analysis[usize::from(import.span.start())..usize::from(import.span.end())],
            "'../modules/katex/lib.notc'"
        );
    }

    #[test]
    fn discovery_removes_only_command_extensions() {
        let source = format!(
            "{REPLACE}[[extensions]]\nkind = 'command'\ncommand = ['sh', 'check.sh']\nstages = ['after_check']\n"
        );
        let stripped = without_commands(&source).expect("command extension removed");
        let parsed = notist::environment::parse_config(&stripped).unwrap();
        assert_eq!(parsed.extensions.len(), 1);
        assert!(stripped.contains("notist.math"));
        assert!(!stripped.contains("command"));
        assert!(without_commands(REPLACE).is_none());
    }
}
