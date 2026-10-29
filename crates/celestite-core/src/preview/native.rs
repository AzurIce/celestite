//! Read-only package grants derived from Notist configuration snapshots.
//! Hosts own watchers and scheduling; the dependency and path policy is shared.
use crate::error::{EditorError, EditorResult, ErrorCode};
use crate::fs::native::FsVault;
use crate::fs::validate_path;
use crate::fs::{EntryKind, FileEntry};
use crate::preview::{
    PreviewResource, PreviewResourceKind, PreviewResourceRequest, ResourceContext,
    manifests::ManifestSource,
};
use notist::{ResourceError, Resources, resources::ResourceKind};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path as FsPath, PathBuf},
};

const LIMIT: u64 = 16 * 1024 * 1024;
struct Discovery<'a> {
    root: &'a FsPath,
    overlays: BTreeMap<PathBuf, &'a str>,
    packages: RefCell<BTreeSet<PathBuf>>,
}
impl Resources for Discovery<'_> {
    fn root(&self) -> &FsPath {
        self.root
    }
    fn read(&self, path: &FsPath) -> Result<Vec<u8>, ResourceError> {
        let path = self.resolve(path);
        if path
            .extension()
            .is_some_and(|extension| extension == "notc")
            || (!path.starts_with(self.root)
                && path.file_name().is_some_and(|name| name == "Notist.toml"))
        {
            self.packages
                .borrow_mut()
                .insert(path.parent().unwrap().to_owned());
        }
        if let Some(source) = self.overlays.get(&path) {
            return Ok(source.as_bytes().to_vec());
        }
        let access = |error: std::io::Error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ResourceError::NotFound(path.clone())
            } else {
                ResourceError::Access {
                    path: path.clone(),
                    message: error.to_string(),
                }
            }
        };
        let file = std::fs::File::open(&path).map_err(access)?;
        let mut data = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut data)
            .map_err(access)?;
        if data.len() as u64 > LIMIT {
            return Err(ResourceError::Access {
                path,
                message: "package input exceeds 16 MiB".into(),
            });
        }
        Ok(data)
    }
    fn kind(&self, path: &FsPath) -> Result<Option<ResourceKind>, ResourceError> {
        let path = self.resolve(path);
        // Nearest document configuration remains scoped to the document Vault.
        if !path.starts_with(self.root) {
            return Ok(None);
        }
        if self.overlays.contains_key(&path) {
            return Ok(Some(ResourceKind::File));
        }
        notist::FsResources::new(self.root).kind(&path)
    }
    fn entries(&self, _: &FsPath) -> Result<Vec<PathBuf>, ResourceError> {
        Ok(vec![])
    }
    fn source(&self, path: &FsPath) -> Result<String, ResourceError> {
        let source = String::from_utf8(self.read(path)?)
            .map_err(|_| ResourceError::InvalidUtf8(self.resolve(path)))?;
        let source = source
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        let path = self.resolve(path);
        if path.file_name().is_some_and(|name| name == "Notist.toml") {
            // Package grants must not run user processes while discovering the
            // import graph. The real preview execution later runs them once.
            Ok(ManifestSource::new(source, true).analysis)
        } else {
            Ok(source)
        }
    }
}
pub struct PackageResources {
    pub root: PathBuf,
}
impl PackageResources {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn grant(&self, context: &ResourceContext) -> EditorResult<PackageGrant> {
        validate_path(&context.document_path)?;
        if context.document_path.is_empty() {
            return Err(EditorError::new(
                ErrorCode::InvalidPath,
                "Expected a source document path",
                "",
            ));
        }
        let mut overlays = BTreeMap::new();
        let mut roots = BTreeMap::new();
        let mut bytes = context.source.len();
        for (path, source) in &context.overlays {
            let identity = if FsPath::new(path).is_absolute() {
                let identity = FsPath::new(path);
                if notist::resources::normalize(identity) != identity
                    || identity
                        .file_name()
                        .is_none_or(|name| name != "Notist.toml")
                {
                    return Err(EditorError::new(
                        ErrorCode::InvalidPath,
                        "External overlays must be normalized Notist configuration paths",
                        path,
                    ));
                }
                identity.to_owned()
            } else {
                validate_path(path)?;
                if path.is_empty() {
                    return Err(EditorError::new(
                        ErrorCode::InvalidPath,
                        "Expected an overlay file path",
                        path,
                    ));
                }
                roots.insert(self.root.join(path), source.as_str());
                self.root.join(path)
            };
            bytes = bytes.saturating_add(source.len());
            if bytes > 32 * 1024 * 1024 {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Source snapshots exceed 32 MiB",
                    path,
                ));
            }
            // External snapshots are consulted only when Notist reaches them through
            // the document's dependency graph. They do not grant arbitrary resource IO.
            overlays.insert(identity, source.as_str());
        }
        if bytes > 32 * 1024 * 1024 {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "Source snapshots exceed 32 MiB",
                &context.document_path,
            ));
        }
        let document = self.root.join(&context.document_path);
        overlays.insert(document.clone(), context.source.as_str());
        roots.insert(document, context.source.as_str());
        let resources = Discovery {
            root: &self.root,
            overlays,
            packages: RefCell::new(BTreeSet::new()),
        };
        // Capture Notist's module graph reads even when assembly is invalid.
        for (path, source) in roots {
            let mut vault = notist::Vault::new(&resources);
            if path
                .extension()
                .is_some_and(|extension| extension == "notc")
            {
                let _ = vault.analyze_code(&path, source);
            } else {
                let _ = vault.environment_for(&path, source);
            }
        }
        let packages = resources.packages.into_inner();
        Ok(PackageGrant { packages })
    }
}

/// Module resources live next to their declaration: .notc modules,
/// configuration, and component implementation assets.
fn allowed_file_extension(relative: &FsPath) -> bool {
    relative.extension().is_some_and(|extension| {
        extension == "notc"
            || extension == "js"
            || extension == "mjs"
            || extension == "wasm"
            || extension == "css"
            || extension == "json"
            || extension == "svg"
            || extension == "png"
            || extension == "jpg"
            || extension == "jpeg"
            || extension == "woff2"
    })
}

/// A bounded capability assembled from one document configuration snapshot.
pub struct PackageGrant {
    packages: BTreeSet<PathBuf>,
}
impl PackageGrant {
    pub fn roots(&self) -> &BTreeSet<PathBuf> {
        &self.packages
    }
    fn resolve(&self, path: &str) -> EditorResult<(FsVault, String, PathBuf)> {
        let resource = FsPath::new(path);
        if !resource.is_absolute() || notist::resources::normalize(resource) != resource {
            return Err(EditorError::new(
                ErrorCode::InvalidPath,
                "Expected an absolute package resource identity",
                path,
            ));
        }
        for root in &self.packages {
            let Ok(relative) = resource.strip_prefix(root) else {
                continue;
            };
            // Module resources live next to their declaration. Paths without
            // an extension may be directories; file reads re-check the suffix.
            let allowed = relative.extension().is_none()
                || allowed_file_extension(relative)
                || relative == FsPath::new("Notist.toml");
            if relative.as_os_str().is_empty() || allowed {
                let relative = relative.to_str().ok_or_else(|| {
                    EditorError::new(
                        ErrorCode::InvalidPath,
                        "Package resource path is not UTF-8",
                        path,
                    )
                })?;
                #[cfg(windows)]
                let relative_slashes = relative.replace('\\', "/");
                #[cfg(windows)]
                let relative = relative_slashes.as_str();
                validate_path(relative)?;
                // An explicit package directory may itself be a symlink. Its contents use
                // the same capability-based IO as Vaults; internal symlinks are rejected.
                let canonical = match root.canonicalize() {
                    Ok(path) => path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Err(EditorError::new(
                            ErrorCode::NotFound,
                            "Package directory does not exist",
                            path,
                        ));
                    }
                    Err(error) => {
                        return Err(EditorError::new(ErrorCode::Io, error.to_string(), path));
                    }
                };
                return FsVault::open(&canonical)
                    .map(|files| (files, relative.to_owned(), canonical))
                    .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), path));
            }
        }
        Err(EditorError::new(
            ErrorCode::PermissionDenied,
            "Resource is not a manifest, declaration or component of a configured package",
            path,
        ))
    }
    /// The authorized directory to observe before resource IO. Only the explicit
    /// package root may resolve through a symlink; descendants retain FsVault's
    /// no-follow policy. Missing resources are observed through an existing
    /// ancestor so their later creation can invalidate the project snapshot.
    pub fn observation_directory(&self, path: &str, directory: bool) -> EditorResult<PathBuf> {
        let (files, relative, root) = self.resolve(path)?;
        let mut relative = FsPath::new(&relative);
        if !directory {
            relative = relative.parent().unwrap_or_else(|| FsPath::new(""));
        }
        loop {
            let name = relative.to_string_lossy().replace('\\', "/");
            match files.stat(&name)? {
                Some(entry) if entry.kind == EntryKind::Directory => return Ok(root.join(relative)),
                Some(entry) => {
                    return Err(EditorError::new(
                        if entry.kind == EntryKind::Symlink {
                            ErrorCode::Unsupported
                        } else {
                            ErrorCode::NotDirectory
                        },
                        "Package observation requires a directory without symbolic links",
                        path,
                    ));
                }
                None => {
                    relative = relative.parent().ok_or_else(|| {
                        EditorError::new(ErrorCode::NotFound, "Package directory disappeared", path)
                    })?;
                }
            }
        }
    }
    pub fn read(&self, request: PreviewResourceRequest) -> EditorResult<PreviewResource> {
        let (files, path, _) = match self.resolve(&request.path) {
            Err(error) if error.code == ErrorCode::NotFound => {
                return Ok(PreviewResource {
                    kind: None,
                    data: None,
                    error: None,
                });
            }
            other => other?,
        };
        let Some(stat) = files.stat(&path)? else {
            return Ok(PreviewResource {
                kind: None,
                data: None,
                error: None,
            });
        };
        if stat.kind == EntryKind::File
            && !allowed_file_extension(FsPath::new(&path))
            && path != "Notist.toml"
        {
            return Err(EditorError::new(
                ErrorCode::PermissionDenied,
                "Resource is not a manifest, declaration or component of a configured package",
                &request.path,
            ));
        }
        let kind = match stat.kind {
            EntryKind::File => PreviewResourceKind::File,
            EntryKind::Directory => PreviewResourceKind::Directory,
            _ => {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Package resource must be a file or directory",
                    &request.path,
                ));
            }
        };
        let data = if request.read && kind == PreviewResourceKind::File {
            Some(files.read_file_limited(&path, LIMIT)?)
        } else {
            None
        };
        Ok(PreviewResource {
            kind: Some(kind),
            data,
            error: None,
        })
    }
    pub fn directory(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        let (files, relative, _) = self.resolve(path)?;
        let mut entries = files.read_dir(&relative)?;
        for entry in &mut entries {
            entry.path = format!(
                "{}/{}",
                path,
                FsPath::new(&entry.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
            );
        }
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::PackageGrant;
    use crate::error::ErrorCode;
    use std::collections::BTreeSet;

    #[test]
    fn observation_is_scoped_to_authorized_resources_and_existing_ancestors() {
        let package = tempfile::tempdir().unwrap();
        let root = package.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("panel")).unwrap();
        let grant = PackageGrant {
            packages: BTreeSet::from([root.clone()]),
        };
        assert_eq!(
            grant
                .observation_directory(root.join("panel/index.js").to_str().unwrap(), false)
                .unwrap(),
            root.join("panel")
        );
        assert_eq!(
            grant
                .observation_directory(root.join("missing/deep").to_str().unwrap(), true)
                .unwrap(),
            root
        );
        assert_eq!(
            grant
                .observation_directory(root.join("private.txt").to_str().unwrap(), false)
                .unwrap_err()
                .code,
            ErrorCode::PermissionDenied
        );
    }

    #[cfg(unix)]
    #[test]
    fn observation_resolves_the_explicit_package_root_but_rejects_internal_links() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let root = base.join("actual");
        let link = base.join("linked-package");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&root, &link).unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::os::unix::fs::symlink(&base, root.join("nested/escape")).unwrap();
        let grant = PackageGrant {
            packages: BTreeSet::from([link.clone()]),
        };
        assert_eq!(
            grant
                .observation_directory(link.join("lib.notc").to_str().unwrap(), false)
                .unwrap(),
            root
        );
        assert_eq!(
            grant
                .observation_directory(
                    link.join("nested/escape/secret.js").to_str().unwrap(),
                    false
                )
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::PackageResources;
    use crate::error::ErrorCode;
    use crate::preview::{PreviewResourceRequest, ResourceContext};
    use std::collections::BTreeMap;

    #[test]
    fn grants_follow_unsaved_roots_and_module_overlays_without_saving_them() {
        let repository = tempfile::tempdir().unwrap();
        let root = repository.path().canonicalize().unwrap();
        let vault = root.join("vault");
        std::fs::create_dir(&vault).unwrap();
        std::fs::write(vault.join("a.not"), "saved without imports").unwrap();
        for name in ["one", "two", "three"] {
            std::fs::create_dir(root.join(name)).unwrap();
            std::fs::write(
                root.join(name).join("lib.notc"),
                "fn panel() -> BlockContent;",
            )
            .unwrap();
        }
        let resources = PackageResources::new(vault.clone());
        let mut context = ResourceContext {
            document_path: "a.not".into(),
            source: "#import \"../one/lib.notc\" as one;\n".into(),
            overlays: BTreeMap::from([
                (
                    "b.not".into(),
                    "#import \"../two/lib.notc\" as two;\n".into(),
                ),
                (
                    "lib.notc".into(),
                    "import \"../three/lib.notc\" as three;\nfn local() -> BlockContent;".into(),
                ),
            ]),
        };
        let grant = resources.grant(&context).unwrap();
        for name in ["one", "two", "three"] {
            assert!(
                grant.roots().contains(&root.join(name)),
                "{name} must be reached through a source snapshot"
            );
            assert!(
                grant
                    .read(PreviewResourceRequest {
                        path: root.join(name).join("lib.notc").to_str().unwrap().into(),
                        read: true
                    })
                    .unwrap()
                    .data
                    .is_some()
            );
        }
        assert_eq!(
            std::fs::read_to_string(vault.join("a.not")).unwrap(),
            "saved without imports"
        );
        context.source = "plain\n".into();
        assert!(
            !resources
                .grant(&context)
                .unwrap()
                .roots()
                .contains(&root.join("one")),
            "saved sources must not restore a removed snapshot import"
        );
        context.overlays.insert(
            root.join("one/forged.notc").to_str().unwrap().into(),
            "fn forged() -> BlockContent;".into(),
        );
        assert_eq!(
            resources.grant(&context).err().unwrap().code,
            ErrorCode::InvalidPath,
            "absolute declarations cannot add authorization roots"
        );
    }
}
