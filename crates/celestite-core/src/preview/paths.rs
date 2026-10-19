//! Wire resource paths belong to the IO host, whose OS can differ from this
//! renderer. Notist sees only an executor-local namespace and never real paths.
use std::path::{Path, PathBuf};

#[cfg(windows)]
const NAMESPACE: &str = "C:/__celestite_preview__";
#[cfg(not(windows))]
const NAMESPACE: &str = "/__celestite_preview__";

#[derive(Clone, Debug, PartialEq, Eq)]
enum Anchor {
    Posix,
    Drive(String),
    Unc(String, String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ResourcePath {
    anchor: Anchor,
    segments: Vec<String>,
}

impl ResourcePath {
    pub(super) fn absolute(value: &str) -> Option<Self> {
        let windows = value.starts_with("\\\\")
            || value.starts_with("//")
            || (value.as_bytes().get(1) == Some(&b':')
                && value.as_bytes().first()?.is_ascii_alphabetic());
        let normalized = windows.then(|| value.replace('\\', "/"));
        let mut value = normalized.as_deref().unwrap_or(value);
        if let Some(verbatim) = value.strip_prefix("//?/") {
            value = verbatim;
            if let Some(unc) = value.strip_prefix("UNC/") {
                let mut parts = unc.split('/').filter(|part| !part.is_empty());
                let anchor = Anchor::Unc(parts.next()?.into(), parts.next()?.into());
                return Some(Self::from_parts(anchor, parts));
            }
        }
        if let Some(unc) = value.strip_prefix("//") {
            let mut parts = unc.split('/').filter(|part| !part.is_empty());
            let anchor = Anchor::Unc(parts.next()?.into(), parts.next()?.into());
            Some(Self::from_parts(anchor, parts))
        } else if value.as_bytes().get(1) == Some(&b':')
            && value.as_bytes().first()?.is_ascii_alphabetic()
            && value.as_bytes().get(2) == Some(&b'/')
        {
            Some(Self::from_parts(
                Anchor::Drive(value[..1].to_ascii_uppercase()),
                value[3..].split('/'),
            ))
        } else if value.starts_with('/') {
            Some(Self::from_parts(Anchor::Posix, value.split('/')))
        } else {
            None
        }
    }

    fn from_parts<'a>(anchor: Anchor, parts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut path = Self {
            anchor,
            segments: Vec::new(),
        };
        path.extend(parts);
        path
    }

    fn extend<'a>(&mut self, parts: impl IntoIterator<Item = &'a str>) {
        for part in parts {
            match part {
                "" | "." => {}
                ".." => {
                    self.segments.pop();
                }
                part => self.segments.push(part.into()),
            }
        }
    }

    pub(super) fn resolve(&self, value: &str) -> Self {
        if let Some(absolute) = Self::absolute(value) {
            return absolute;
        }
        let normalized = (!matches!(self.anchor, Anchor::Posix)).then(|| value.replace('\\', "/"));
        let mut path = self.clone();
        path.extend(normalized.as_deref().unwrap_or(value).split('/'));
        path
    }

    pub(super) fn parent(&self) -> Self {
        let mut parent = self.clone();
        parent.segments.pop();
        parent
    }

    fn relative_to(&self, root: &Self) -> Option<String> {
        (self.anchor == root.anchor && self.segments.starts_with(&root.segments))
            .then(|| self.segments[root.segments.len()..].join("/"))
    }

    pub(super) fn wire(&self) -> String {
        let root = match &self.anchor {
            Anchor::Posix => String::new(),
            Anchor::Drive(drive) => format!("{drive}:"),
            Anchor::Unc(host, share) => format!("//{host}/{share}"),
        };
        if self.segments.is_empty() && matches!(self.anchor, Anchor::Unc(_, _)) {
            root
        } else {
            format!("{root}/{}", self.segments.join("/"))
        }
    }

    pub(super) fn engine(&self) -> PathBuf {
        let mut path = PathBuf::from(NAMESPACE);
        match &self.anchor {
            Anchor::Posix => path.push("posix"),
            Anchor::Drive(drive) => {
                path.push("drive");
                path.push(drive);
            }
            Anchor::Unc(host, share) => {
                path.push("unc");
                path.push(host);
                path.push(share);
            }
        }
        path.extend(&self.segments);
        path
    }

    fn from_engine(path: &Path) -> Option<Self> {
        // Separators here belong to the executor namespace, not the IO host.
        let text = path.to_string_lossy().replace('\\', "/");
        // Unsupported std path targets can join an already rooted identity as
        // relative. The final namespace marker still identifies that identity.
        let (_, suffix) = text.rsplit_once(&format!("{NAMESPACE}/"))?;
        let mut parts = suffix.split('/');
        let anchor = match parts.next()? {
            "posix" => Anchor::Posix,
            "drive" => Anchor::Drive(parts.next()?.into()),
            "unc" => Anchor::Unc(parts.next()?.into(), parts.next()?.into()),
            _ => return None,
        };
        Some(Self::from_parts(anchor, parts))
    }
}

pub(super) struct ResourceNamespace {
    root: ResourcePath,
    engine_root: PathBuf,
}

impl ResourceNamespace {
    pub(super) fn new(root: &str) -> Self {
        // Invalid roots remain isolated from IO. The task boundary ordinarily
        // supplies /vault or an absolute native root from a trusted descriptor.
        let root = ResourcePath::absolute(root)
            .unwrap_or_else(|| ResourcePath::absolute("/vault").unwrap());
        let engine_root = root.engine();
        Self { root, engine_root }
    }

    pub(super) fn root(&self) -> &Path {
        &self.engine_root
    }

    pub(super) fn path(&self, path: &Path) -> ResourcePath {
        ResourcePath::from_engine(path)
            .unwrap_or_else(|| self.root.resolve(&path.to_string_lossy()))
    }

    pub(super) fn key(&self, path: &Path) -> String {
        let path = self.path(path);
        path.relative_to(&self.root).unwrap_or_else(|| path.wire())
    }

    pub(super) fn resolve(&self, path: &Path) -> PathBuf {
        self.path(path).engine()
    }

    pub(super) fn message(&self, message: &str) -> String {
        message
            .split('`')
            .enumerate()
            .map(|(index, part)| {
                if index % 2 == 1 && ResourcePath::from_engine(Path::new(part)).is_some() {
                    self.key(Path::new(part))
                } else {
                    part.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("`")
    }
}

#[cfg(test)]
mod tests {
    use super::{ResourceNamespace, ResourcePath};
    use std::path::Path;

    #[test]
    fn foreign_roots_roundtrip_without_native_path_semantics() {
        for root in [
            "/workspace/vault",
            "C:/workspace/vault",
            "//host/share/vault",
        ] {
            let namespace = ResourceNamespace::new(root);
            let document = namespace.resolve(Path::new("sub/a.not"));
            assert_eq!(namespace.key(&document), "sub/a.not");
            assert_eq!(namespace.resolve(&document), document);
            assert_eq!(
                namespace.path(&document).wire(),
                format!("{root}/sub/a.not")
            );
            let sibling = namespace.path(&document).parent().resolve("../../package");
            assert_eq!(
                namespace.key(&sibling.engine()),
                format!("{}/package", root.rsplit_once('/').unwrap().0)
            );
        }
    }

    #[test]
    fn drive_unc_and_relative_windows_separators_are_canonical() {
        let root = ResourcePath::absolute(r"C:\vault\chapters").unwrap();
        assert_eq!(
            root.resolve(r"..\packages\widgets").wire(),
            "C:/vault/packages/widgets"
        );
        assert_eq!(root.resolve(r"D:\widgets").wire(), "D:/widgets");
        assert_eq!(
            ResourcePath::absolute(r"\\host\share\a").unwrap().wire(),
            "//host/share/a"
        );
        assert_eq!(
            ResourcePath::absolute(r"\\?\UNC\host\share\a")
                .unwrap()
                .wire(),
            "//host/share/a"
        );
        assert_eq!(root.resolve("../../../../x").wire(), "C:/x");
    }
}
