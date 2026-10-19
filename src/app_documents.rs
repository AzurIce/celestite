//! Private application settings and connection catalogue, separate from Vault files.
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use celestite_core::fs::native::write_json;
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Copy, Deserialize)]
pub enum AppDocument {
    #[serde(rename = "settings.json")]
    Settings,
    #[serde(rename = "connections.json")]
    Connections,
}
impl AppDocument {
    fn file_name(self) -> &'static str {
        match self {
            Self::Settings => "settings.json",
            Self::Connections => "connections.json",
        }
    }
}
pub struct AppDocuments {
    root: PathBuf,
    _lock: File,
    writes: Mutex<()>,
}
impl AppDocuments {
    pub fn open(data: &Path) -> EditorResult<Self> {
        fs::create_dir_all(data).map_err(super::io_error)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(data.join("application.lock"))
            .map_err(super::io_error)?;
        lock.try_lock().map_err(|error| {
            EditorError::new(
                ErrorCode::Busy,
                format!("此应用数据目录已被另一个 Celestite 进程使用：{error}"),
                "",
            )
        })?;
        let root = data.join("application");
        fs::create_dir_all(&root).map_err(super::io_error)?;
        Ok(Self {
            root,
            _lock: lock,
            writes: Mutex::new(()),
        })
    }
    pub fn read(&self, name: AppDocument) -> EditorResult<Option<String>> {
        match fs::read_to_string(self.root.join(name.file_name())) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(super::io_error(error)),
        }
    }
    pub fn write(&self, name: AppDocument, document: &Value) -> EditorResult<()> {
        if !document.is_object() || document.to_string().len() > 1024 * 1024 {
            return Err(EditorError::new(
                ErrorCode::InvalidEdit,
                "应用配置必须是小于 1 MiB 的 JSON 对象。",
                "",
            ));
        }
        let _guard = self.writes.lock().map_err(super::io_error)?;
        write_json(&self.root.join(name.file_name()), document)
    }
}
#[cfg(test)]
mod tests {
    use super::{AppDocument, AppDocuments};
    use celestite_core::error::ErrorCode;
    use serde_json::json;

    #[test]
    fn settings_and_credentials_survive_restart_outside_the_vault() {
        let directory = tempfile::tempdir().unwrap();
        let documents = AppDocuments::open(directory.path()).unwrap();
        assert!(documents.read(AppDocument::Settings).unwrap().is_none());
        documents
            .write(AppDocument::Settings, &json!({"theme.mode":"dark"}))
            .unwrap();
        documents
            .write(
                AppDocument::Connections,
                &json!({"version":3,"connections":[{"url":"https://host/secret"}]}),
            )
            .unwrap();
        assert!(documents.write(AppDocument::Settings, &json!([])).is_err());
        assert!(
            matches!(AppDocuments::open(directory.path()), Err(error) if error.code == ErrorCode::Busy)
        );
        drop(documents);
        let restored = AppDocuments::open(directory.path()).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &restored.read(AppDocument::Settings).unwrap().unwrap()
            )
            .unwrap(),
            json!({"theme.mode":"dark"})
        );
        assert!(
            restored
                .read(AppDocument::Connections)
                .unwrap()
                .unwrap()
                .contains("https://host/secret")
        );
    }
}
