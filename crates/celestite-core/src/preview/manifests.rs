//! Rewrite only dependency path literals in the immutable analysis snapshot.
//! Source positions and text exposed to the editor remain the original input.
use super::paths::ResourcePath;
use serde::Deserialize;
use std::{collections::BTreeMap, ops::Range};

#[derive(Deserialize)]
struct Dependency {
    path: toml::Spanned<String>,
}

#[derive(Default, Deserialize)]
struct Manifest {
    #[serde(default)]
    dependencies: BTreeMap<String, Dependency>,
    #[serde(default, rename = "dev-dependencies")]
    dev_dependencies: BTreeMap<String, Dependency>,
}

struct Replacement {
    original: Range<usize>,
    analysis: Range<usize>,
}

pub(super) struct ManifestSource {
    pub(super) original: String,
    pub(super) analysis: String,
    replacements: Vec<Replacement>,
}

impl ManifestSource {
    pub(super) fn new(path: &ResourcePath, original: String) -> Self {
        let mut source = Self {
            analysis: original.clone(),
            original,
            replacements: Vec::new(),
        };
        let Ok(manifest) = toml::from_str::<Manifest>(&source.original) else {
            // Notist owns syntax/semantic diagnostics. Invalid input reaches it
            // unchanged, retaining its original diagnostics and byte spans.
            return source;
        };
        let owner = path.parent();
        let mut paths = manifest
            .dependencies
            .into_values()
            .chain(manifest.dev_dependencies.into_values())
            .map(|dependency| dependency.path)
            .filter(|path| !path.get_ref().is_empty())
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| path.span().start);
        source.analysis.clear();
        let mut position = 0;
        for path in paths {
            let original = path.span();
            source
                .analysis
                .push_str(&source.original[position..original.start]);
            let start = source.analysis.len();
            // JSON string escaping is valid for these TOML basic strings.
            source.analysis.push_str(
                &serde_json::to_string(&owner.resolve(path.get_ref()).engine().to_string_lossy())
                    .expect("path strings serialize"),
            );
            source.replacements.push(Replacement {
                original: original.clone(),
                analysis: start..source.analysis.len(),
            });
            position = original.end;
        }
        source.analysis.push_str(&source.original[position..]);
        source
    }

    fn original_offset(&self, offset: usize, end: bool) -> usize {
        let mut previous_analysis = 0;
        let mut previous_original = 0;
        for replacement in &self.replacements {
            if offset < replacement.analysis.start {
                return previous_original + offset.saturating_sub(previous_analysis);
            }
            if offset <= replacement.analysis.end {
                return if end || offset == replacement.analysis.end {
                    replacement.original.end
                } else {
                    replacement.original.start
                };
            }
            previous_analysis = replacement.analysis.end;
            previous_original = replacement.original.end;
        }
        previous_original + offset.saturating_sub(previous_analysis)
    }

    pub(super) fn range(&self, from: usize, to: usize) -> Range<usize> {
        self.original_offset(from, false)..self.original_offset(to, true)
    }
}

#[cfg(test)]
mod tests {
    use super::ManifestSource;
    use crate::preview::paths::ResourcePath;

    #[test]
    fn rewritten_paths_keep_configuration_diagnostic_positions() {
        let original = "[dependencies]\nwidgets = {path = '../widgets'}\n[[transforms]]\nkind = 'replace'\nfrom = 'notist::math'\nto = 'widgets::math'\n";
        let source = ManifestSource::new(
            &ResourcePath::absolute("C:/repo/docs/Notist.toml").unwrap(),
            original.into(),
        );
        assert_ne!(source.analysis, source.original);
        let start = source.analysis.find("notist::math").unwrap();
        let range = source.range(start, start + "notist::math".len());
        assert_eq!(&source.original[range], "notist::math");
        let parsed = notist::environment::parse_config(&source.analysis).unwrap();
        let dependency = &parsed.dependencies[0];
        let span = source.range(
            usize::from(dependency.span.start()),
            usize::from(dependency.span.end()),
        );
        assert_eq!(&source.original[span], "{path = '../widgets'}");
    }
}
