//! Database bootstrap: connection configuration, migrations and the
//! pre-migration safety copy.

pub mod migrations;

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::Path;

pub const SCHEMA_VERSION: i64 = migrations::MIGRATIONS.len() as i64;

/// Applies connection-level pragmas. WAL gives crash-safe, concurrent-read
/// friendly writes; foreign keys keep relationships consistent.
pub fn configure(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -16000;",
    )?;
    Ok(())
}

pub fn user_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Opens (creating if necessary) the database at `path` and brings the
/// schema up to date. If an existing database needs migrating, a full copy
/// is written to `safety_dir` first so a failed upgrade can be recovered.
pub fn open(path: &Path, safety_dir: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    let version = user_version(&conn)?;
    if version > SCHEMA_VERSION {
        return Err(AppError::Invalid(format!(
            "This data was created by a newer version of the app (schema {version}, supported {SCHEMA_VERSION}). Update the app to open it."
        )));
    }
    if version > 0 && version < SCHEMA_VERSION {
        std::fs::create_dir_all(safety_dir)?;
        let target = safety_dir.join(format!(
            "pre-migration-v{version}-{}.db",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])?;
    }
    migrate(&conn)?;
    Ok(conn)
}

/// Runs all pending migrations, each atomically.
pub fn migrate(conn: &Connection) -> AppResult<()> {
    let current = user_version(conn)?;
    for (idx, sql) in migrations::MIGRATIONS.iter().enumerate() {
        let version = idx as i64 + 1;
        if version <= current {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        tx.commit()?;
    }
    Ok(())
}

/// Opens an in-memory database with the full schema (tests).
#[cfg(test)]
pub fn open_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrate(&conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_data_survives_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kern.db");
        {
            // A database as the first release left it.
            let conn = Connection::open(&path).unwrap();
            configure(&conn).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute_batch(migrations::MIGRATIONS[0]).unwrap();
            tx.execute_batch("PRAGMA user_version = 1").unwrap();
            tx.commit().unwrap();
            conn.execute_batch(
                "INSERT INTO projects(id, name, created_at, updated_at) VALUES ('p1', 'Studbase', 1, 1);
                 INSERT INTO tasks(id, title, project_id, created_at, updated_at) VALUES ('t1', 'Keep me', 'p1', 1, 1);
                 INSERT INTO settings(key, value, updated_at) VALUES ('data.linkPreviews', 'false', 1);",
            )
            .unwrap();
        }
        let safety = dir.path().join("backups");
        let conn = open(&path, &safety).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let (title, project): (String, String) =
            conn.query_row("SELECT title, project_id FROM tasks WHERE id = 't1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((title.as_str(), project.as_str()), ("Keep me", "p1"));
        let prefs: String = conn.query_row("SELECT ai_prefs FROM projects WHERE id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(prefs, "{}");
        let fav: String = conn.query_row("SELECT value FROM settings WHERE key = 'privacy.favicons'", [], |r| r.get(0)).unwrap();
        assert_eq!(fav, "false", "an existing opt-out carries over to favicons");
        // A safety copy was written before migrating.
        assert_eq!(std::fs::read_dir(&safety).unwrap().count(), 1);
    }

    #[test]
    fn v3_projects_gain_phase_three_without_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kern.db");
        {
            let conn = Connection::open(&path).unwrap();
            configure(&conn).unwrap();
            for (i, sql) in migrations::MIGRATIONS[..3].iter().enumerate() {
                let tx = conn.unchecked_transaction().unwrap();
                tx.execute_batch(sql).unwrap();
                tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).unwrap();
                tx.commit().unwrap();
            }
            conn.execute_batch(
                "INSERT INTO projects(id, name, created_at, updated_at) VALUES ('p1', 'Reactor', 1, 1);
                 INSERT INTO tasks(id, title, project_id, status, created_at, updated_at) VALUES ('t1', 'Cooling', 'p1', 'todo', 1, 1);
                 INSERT INTO project_repos(project_id, owner, name, connected_at) VALUES ('p1', 'acme', 'reactor', 1);
                 INSERT INTO task_issue_links(repo, issue_number, task_id, project_id, html_url, synced_at) VALUES ('acme/reactor', 7, 't1', 'p1', 'u', 1);",
            )
            .unwrap();
        }
        let conn = open(&path, &dir.path().join("backups")).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        let t = crate::domain::tasks::get_task(&conn, "t1").unwrap();
        assert_eq!((t.title.as_str(), t.milestone_id, t.issue.map(|i| i.number)), ("Cooling", None, Some(7)));
        // The existing GitHub connection shows up as a repository link, unchanged.
        let repos = crate::domain::repos::list(&conn, "p1").unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].github.as_deref(), Some("acme/reactor"));
        assert!(repos[0].issue_sync);
        let p = crate::domain::projects::get_project(&conn, "p1").unwrap();
        assert_eq!(p.github_repo.as_deref(), Some("acme/reactor"));
    }
}
