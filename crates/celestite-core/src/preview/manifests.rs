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
    #[derive(serde::Deserialize)]
    struct Config {
        #[serde(default)]
        extensions: Vec<toml::Spanned<toml::Value>>,
    }
    let config: Config = toml::from_str(source).ok()?;
    let spans: Vec<_> = config
        .extensions
        .iter()
        .filter(|extension| {
            extension
                .get_ref()
                .get("kind")
                .and_then(toml::Value::as_str)
                == Some("command")
        })
        .map(toml::Spanned::span)
        .collect();
    if spans.is_empty() {
        return None;
    }
    let mut bytes = source.as_bytes().to_vec();
    for span in spans {
        for byte in &mut bytes[span] {
            if *byte != b'\n' && *byte != b'\r' {
                *byte = b' ';
            }
        }
    }
    String::from_utf8(bytes).ok()
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
        assert_eq!(stripped.len(), source.len());
        assert!(stripped.starts_with(REPLACE));
        assert!(without_commands(REPLACE).is_none());
    }

    #[test]
    fn discovery_preserves_package_site_and_later_diagnostic_byte_ranges() {
        let source = format!(
            "[package]\nname = 'notes'\n[site]\ncontent = '.'\ntheme = 'builtins.book'\n[[extensions]]\nkind = 'command'\ncommand = ['echo', '😀 中文']\nstages = ['after_check']\n{REPLACE}"
        );
        let stripped = without_commands(&source).unwrap();
        let parsed = notist::environment::parse_config(&stripped).unwrap();
        assert_eq!(parsed.extensions.len(), 1);
        let import = &parsed.extensions[0].imports()[0];
        let range = usize::from(import.span.start())..usize::from(import.span.end());
        assert_eq!(&source[range.clone()], &stripped[range]);
        let config: toml::Value = toml::from_str(&stripped).unwrap();
        assert_eq!(config["package"]["name"].as_str(), Some("notes"));
        assert_eq!(config["site"]["theme"].as_str(), Some("builtins.book"));
    }
}
