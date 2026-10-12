use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub attachments_dir: PathBuf,
    pub default_backups_dir: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            db_path: data_dir.join("kern.db"),
            attachments_dir: data_dir.join("attachments"),
            default_backups_dir: data_dir.join("backups"),
            data_dir,
        }
    }
}

pub struct AppState {
    db: Mutex<Connection>,
    pub paths: Paths,
    /// Generation counter used to cancel scheduled focus-timer notifications.
    pub focus_generation: AtomicU64,
    /// Set once the window has been hidden to the tray so it can be restored.
    pub quitting: std::sync::atomic::AtomicBool,
}

impl AppState {
    pub fn new(conn: Connection, paths: Paths) -> Self {
        Self {
            db: Mutex::new(conn),
            paths,
            focus_generation: AtomicU64::new(0),
            quitting: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Runs `f` with exclusive access to the database connection.
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self
            .db
            .lock()
            .map_err(|_| AppError::Other("Database lock was poisoned; restart the app.".into()))?;
        f(&mut guard)
    }
}
