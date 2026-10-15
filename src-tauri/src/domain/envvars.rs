// @Author Christian Relf
// @Date 2026-10-12

//! Project environment profiles (Development, Testing, …) for saved commands
//! and terminals.
//!
//! Plain values are stored in SQLite. Secret values go to the OS credential
//! store (the same vault as AI keys) and only a reference is kept here; they
//! are never returned unless the user explicitly reveals one, never logged,
//! and only injected into the environment of a process Kern launches. The
//! system's own environment is never modified.

use crate::domain::ai::vault::{Secret, SecretStore};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    /// plain | secret | inherit
    pub kind: String,
    /// The plain value, or for `inherit` the system variable it copies.
    /// Always None for secrets.
    pub value: Option<String>,
    pub has_secret: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvProfile {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub variables: Vec<EnvVar>,
}

pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Names that commonly hold credentials (used to default imports to secret).
pub fn looks_secret(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "PRIVATE", "API_KEY", "APIKEY", "ACCESS_KEY", "CREDENTIAL", "DSN", "DATABASE_URL", "AUTH"]
        .iter()
        .any(|k| n.contains(k))
        || n.ends_with("_KEY")
}

fn secret_ref(var_id: &str) -> String {
    format!("env-secret:{var_id}")
}

fn vars(conn: &Connection, profile_id: &str) -> AppResult<Vec<EnvVar>> {
    let mut stmt = conn.prepare("SELECT id, profile_id, name, kind, value, secret_ref FROM env_variables WHERE profile_id = ?1 ORDER BY sort_order, name")?;
    let rows = stmt.query_map([profile_id], |r| {
        let kind: String = r.get(3)?;
        let secret: Option<String> = r.get(5)?;
        Ok(EnvVar {
            id: r.get(0)?,
            profile_id: r.get(1)?,
            name: r.get(2)?,
            value: if kind == "secret" { None } else { r.get(4)? },
            has_secret: secret.is_some(),
            kind,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn profile(conn: &Connection, id: &str) -> AppResult<EnvProfile> {
    let (project_id, name): (String, String) = conn
        .query_row("SELECT project_id, name FROM env_profiles WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| AppError::NotFound("Environment profile".into()))?;
    Ok(EnvProfile { id: id.to_string(), project_id, name, variables: vars(conn, id)? })
}

pub fn profiles(conn: &Connection, project_id: &str) -> AppResult<Vec<EnvProfile>> {
    let mut stmt = conn.prepare("SELECT id FROM env_profiles WHERE project_id = ?1 ORDER BY sort_order, name")?;
    let ids: Vec<String> = stmt.query_map([project_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    ids.iter().map(|i| profile(conn, i)).collect()
}

pub fn create_profile(conn: &Connection, project_id: &str, name: &str) -> AppResult<EnvProfile> {
    let name = name.trim();
    if name.is_empty() {
        return invalid("Name the profile.");
    }
    let now = now_ms();
    let id = new_id();
    let sort: f64 = conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM env_profiles WHERE project_id = ?1", [project_id], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO env_profiles(id, project_id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, project_id, name, sort, now],
    )?;
    profile(conn, &id)
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VarInput {
    pub profile_id: String,
    /// Existing variable to edit.
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    /// Plain value, inherited variable name, or a new secret. For an
    /// existing secret, None keeps the stored value.
    pub value: Option<String>,
}

pub fn set_var(conn: &Connection, vault: &dyn SecretStore, input: &VarInput) -> AppResult<EnvVar> {
    let name = input.name.trim();
    if !valid_name(name) {
        return invalid("Variable names use letters, digits and underscores, and don't start with a digit.");
    }
    if !["plain", "secret", "inherit"].contains(&input.kind.as_str()) {
        return invalid("Unknown variable type.");
    }
    if input.kind == "inherit" && !input.value.as_deref().is_some_and(valid_name) {
        return invalid("Enter the name of the system variable to copy.");
    }
    let now = now_ms();
    let id = input.id.clone().unwrap_or_else(new_id);
    let existing: Option<(Option<String>, String)> =
        conn.query_row("SELECT secret_ref, kind FROM env_variables WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let clash: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM env_variables WHERE profile_id = ?1 AND name = ?2 AND id != ?3)",
        params![input.profile_id, name, id],
        |r| r.get(0),
    )?;
    if clash {
        return invalid(&format!("{name} is already in this profile."));
    }
    let (value, sref) = if input.kind == "secret" {
        let r = secret_ref(&id);
        match &input.value {
            Some(v) => vault.set(&r, &Secret::new(v.clone()))?,
            None if existing.as_ref().and_then(|e| e.0.clone()).is_none() => return invalid("Enter the secret value."),
            None => {}
        }
        (None, Some(r))
    } else {
        (input.value.clone().map(|v| if input.kind == "inherit" { v.trim().to_string() } else { v }), None)
    };
    if existing.is_some() {
        conn.execute(
            "UPDATE env_variables SET name = ?1, kind = ?2, value = ?3, secret_ref = ?4, updated_at = ?5 WHERE id = ?6",
            params![name, input.kind, value, sref, now, id],
        )?;
    } else {
        let sort: f64 = conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM env_variables WHERE profile_id = ?1", [&input.profile_id], |r| r.get(0))?;
        conn.execute(
            "INSERT INTO env_variables(id, profile_id, name, kind, value, secret_ref, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, input.profile_id, name, input.kind, value, sref, sort, now],
        )?;
    }
    vars(conn, &input.profile_id)?.into_iter().find(|v| v.id == id).ok_or_else(|| AppError::Other("Variable vanished".into()))
}

/// Removes credential-store entries whose variables were deleted.
pub fn sweep(conn: &Connection, vault: &dyn SecretStore) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT ref FROM vault_tombstones LIMIT 200")?;
    let refs: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for r in refs {
        // A ref that's live again (re-saved) must not be deleted.
        let live: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM env_variables WHERE secret_ref = ?1)", [&r], |x| x.get(0))?;
        if live || vault.delete(&r).is_ok() {
            conn.execute("DELETE FROM vault_tombstones WHERE ref = ?1", [&r])?;
        }
    }
    Ok(())
}

/// Name/value pairs to inject into a launched process. Secret values are
/// read from the credential store here and nowhere else.
pub fn resolve(conn: &Connection, vault: &dyn SecretStore, profile_id: &str) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT name, kind, value, secret_ref FROM env_variables WHERE profile_id = ?1 ORDER BY sort_order")?;
    let rows: Vec<(String, String, Option<String>, Option<String>)> =
        stmt.query_map([profile_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
    let mut out = vec![];
    for (name, kind, value, sref) in rows {
        match kind.as_str() {
            "secret" => {
                let s = sref.and_then(|r| vault.get(&r).ok().flatten()).ok_or_else(|| AppError::Invalid(format!("The secret for {name} is missing from the credential store. Set it again.")))?;
                out.push((name, s.expose().to_string()));
            }
            "inherit" => {
                if let Some(v) = value.and_then(|src| std::env::var(src).ok()) {
                    out.push((name, v));
                }
            }
            _ => out.push((name, value.unwrap_or_default())),
        }
    }
    Ok(out)
}

/// Parses a `.env` file: KEY=VALUE lines, optional `export`, quotes and
/// comments. Malformed lines are skipped.
pub fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let l = l.strip_prefix("export ").unwrap_or(l);
        let Some((k, v)) = l.split_once('=') else { continue };
        let k = k.trim();
        if !valid_name(k) {
            continue;
        }
        let v = v.trim();
        let value = if let Some(inner) = v.strip_prefix('"').and_then(|x| x.rfind('"').map(|i| &x[..i])) {
            inner.replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")
        } else if let Some(inner) = v.strip_prefix('\'').and_then(|x| x.rfind('\'').map(|i| &x[..i])) {
            inner.to_string()
        } else {
            v.split(" #").next().unwrap_or("").trim().to_string()
        };
        out.push((k.to_string(), value));
    }
    out
}

fn quote(v: &str) -> String {
    if v.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@,+".contains(c)) && !v.is_empty() {
        v.to_string()
    } else {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n"))
    }
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn env_profiles_list(state: State<AppState>, project_id: String) -> AppResult<Vec<EnvProfile>> {
    state.with(|c| profiles(c, &project_id))
}

#[tauri::command]
pub fn env_profile_create(state: State<AppState>, project_id: String, name: String) -> AppResult<EnvProfile> {
    state.with(|c| create_profile(c, &project_id, &name))
}

#[tauri::command]
pub fn env_profile_rename(state: State<AppState>, id: String, name: String) -> AppResult<EnvProfile> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return invalid("Name the profile.");
    }
    state.with(|c| {
        c.execute("UPDATE env_profiles SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name, now_ms(), id])?;
        profile(c, &id)
    })
}

#[tauri::command]
pub fn env_profile_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM env_profiles WHERE id = ?1", [&id])?;
        sweep(c, state.ai.vault.as_ref())
    })
}

/// Copies a profile, including its secrets (stored under new references).
#[tauri::command]
pub fn env_profile_duplicate(state: State<AppState>, id: String) -> AppResult<EnvProfile> {
    state.with(|c| {
        let src = profile(c, &id)?;
        let tx = c.transaction()?;
        let copy = create_profile(&tx, &src.project_id, &format!("{} copy", src.name))?;
        for v in &src.variables {
            let value = if v.kind == "secret" {
                let r: Option<String> = tx.query_row("SELECT secret_ref FROM env_variables WHERE id = ?1", [&v.id], |x| x.get(0))?;
                r.and_then(|r| state.ai.vault.get(&r).ok().flatten()).map(|s| s.expose().to_string())
            } else {
                v.value.clone()
            };
            if v.kind == "secret" && value.is_none() {
                continue;
            }
            set_var(&tx, state.ai.vault.as_ref(), &VarInput { profile_id: copy.id.clone(), id: None, name: v.name.clone(), kind: v.kind.clone(), value })?;
        }
        tx.commit()?;
        profile(c, &copy.id)
    })
}

#[tauri::command]
pub fn env_var_set(state: State<AppState>, input: VarInput) -> AppResult<EnvVar> {
    state.with(|c| {
        let v = set_var(c, state.ai.vault.as_ref(), &input)?;
        sweep(c, state.ai.vault.as_ref())?;
        Ok(v)
    })
}

#[tauri::command]
pub fn env_var_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM env_variables WHERE id = ?1", [&id])?;
        sweep(c, state.ai.vault.as_ref())
    })
}

/// Returns a variable's value on explicit request (the "reveal" action).
#[tauri::command]
pub fn env_var_reveal(state: State<AppState>, id: String) -> AppResult<String> {
    state.with(|c| {
        let (kind, value, sref): (String, Option<String>, Option<String>) = c
            .query_row("SELECT kind, value, secret_ref FROM env_variables WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?
            .ok_or_else(|| AppError::NotFound("Variable".into()))?;
        match kind.as_str() {
            "secret" => sref
                .and_then(|r| state.ai.vault.get(&r).ok().flatten())
                .map(|s| s.expose().to_string())
                .ok_or_else(|| AppError::Invalid("The secret is missing from the credential store.".into())),
            "inherit" => Ok(value.and_then(|v| std::env::var(v).ok()).unwrap_or_default()),
            _ => Ok(value.unwrap_or_default()),
        }
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub secrets: usize,
}

/// Imports a `.env` file. Names that look like credentials become secrets
/// when `auto_secret` is set (or all values when `all_secret`). Existing
/// variables are only replaced with `overwrite`.
#[tauri::command]
pub fn env_import(state: State<AppState>, profile_id: String, path: String, auto_secret: bool, all_secret: bool, overwrite: bool) -> AppResult<ImportResult> {
    let meta = std::fs::metadata(&path)?;
    if !meta.is_file() || meta.len() > 512 * 1024 {
        return invalid("Choose a .env file (up to 512 KB).");
    }
    let bytes = std::fs::read(&path)?;
    let text = String::from_utf8_lossy(&bytes);
    let pairs = parse_dotenv(&text);
    state.with(|c| {
        let existing = vars(c, &profile_id)?;
        let tx = c.transaction()?;
        let mut res = ImportResult { added: 0, updated: 0, skipped: 0, secrets: 0 };
        for (k, v) in pairs {
            let prev = existing.iter().find(|e| e.name == k);
            if prev.is_some() && !overwrite {
                res.skipped += 1;
                continue;
            }
            let secret = all_secret || (auto_secret && looks_secret(&k));
            set_var(
                &tx,
                state.ai.vault.as_ref(),
                &VarInput { profile_id: profile_id.clone(), id: prev.map(|p| p.id.clone()), name: k, kind: if secret { "secret".into() } else { "plain".into() }, value: Some(v) },
            )?;
            if secret {
                res.secrets += 1;
            }
            if prev.is_some() {
                res.updated += 1;
            } else {
                res.added += 1;
            }
        }
        tx.commit()?;
        sweep(c, state.ai.vault.as_ref())?;
        Ok(res)
    })
}

/// Writes a profile as a `.env` file. Secrets are left out (as commented
/// names) unless `include_secrets` is explicitly set; an existing file is
/// only replaced with `overwrite`.
#[tauri::command]
pub fn env_export(state: State<AppState>, profile_id: String, path: String, include_secrets: bool, overwrite: bool) -> AppResult<usize> {
    if Path::new(&path).exists() && !overwrite {
        return invalid("That file already exists.");
    }
    let resolved = state.with(|c| {
        let p = profile(c, &profile_id)?;
        let mut out = vec![];
        for v in &p.variables {
            let value = match v.kind.as_str() {
                "secret" if include_secrets => {
                    let r: Option<String> = c.query_row("SELECT secret_ref FROM env_variables WHERE id = ?1", [&v.id], |x| x.get(0))?;
                    r.and_then(|r| state.ai.vault.get(&r).ok().flatten()).map(|s| s.expose().to_string())
                }
                "secret" => None,
                "inherit" => v.value.clone().and_then(|src| std::env::var(src).ok()),
                _ => v.value.clone(),
            };
            out.push((v.name.clone(), v.kind.clone(), value));
        }
        Ok((p.name, out))
    })?;
    let (name, vars) = resolved;
    let mut text = format!("# Exported from Kern ({name})\n");
    let mut n = 0;
    for (k, kind, v) in vars {
        match v {
            Some(v) => {
                text.push_str(&format!("{k}={}\n", quote(&v)));
                n += 1;
            }
            None if kind == "secret" => text.push_str(&format!("# {k}= (secret not exported)\n")),
            None => {}
        }
    }
    std::fs::write(&path, text)?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::ai::vault::MemoryStore;
    use crate::domain::projects::{create_project, ProjectInput};

    #[test]
    fn parses_dotenv_files() {
        let t = "# comment\nexport API_URL=https://x.test # trailing\nTOKEN=\"a b\\n c\"\nSINGLE='raw \\n'\n1BAD=x\nEMPTY=\n";
        let p = parse_dotenv(t);
        assert_eq!(p[0], ("API_URL".into(), "https://x.test".into()));
        assert_eq!(p[1], ("TOKEN".into(), "a b\n c".into()));
        assert_eq!(p[2], ("SINGLE".into(), "raw \\n".into()));
        assert_eq!(p[3], ("EMPTY".into(), "".into()));
        assert_eq!(p.len(), 4);
    }

    #[test]
    fn secrets_live_in_the_vault_only() {
        let c = open_memory();
        let vault = MemoryStore::default();
        let pr = create_project(&c, &ProjectInput { name: "API".into(), ..Default::default() }).unwrap();
        let prof = create_profile(&c, &pr.id, "Development").unwrap();
        set_var(&c, &vault, &VarInput { profile_id: prof.id.clone(), id: None, name: "PORT".into(), kind: "plain".into(), value: Some("3000".into()) }).unwrap();
        let s = set_var(&c, &vault, &VarInput { profile_id: prof.id.clone(), id: None, name: "API_KEY".into(), kind: "secret".into(), value: Some("sk-live-123".into()) }).unwrap();
        assert!(s.value.is_none() && s.has_secret);
        let stored: Option<String> = c.query_row("SELECT value FROM env_variables WHERE id = ?1", [&s.id], |r| r.get(0)).unwrap();
        assert!(stored.is_none(), "no secret in SQLite");
        let dump: String = c.query_row("SELECT group_concat(coalesce(value, '') || coalesce(secret_ref, '')) FROM env_variables", [], |r| r.get(0)).unwrap();
        assert!(!dump.contains("sk-live-123"));
        // Editing without a new value keeps the secret.
        set_var(&c, &vault, &VarInput { profile_id: prof.id.clone(), id: Some(s.id.clone()), name: "API_KEY".into(), kind: "secret".into(), value: None }).unwrap();
        let env = resolve(&c, &vault, &prof.id).unwrap();
        assert!(env.contains(&("API_KEY".into(), "sk-live-123".into())) && env.contains(&("PORT".into(), "3000".into())));
        // Deleting the variable removes the vault entry on the next sweep.
        c.execute("DELETE FROM env_variables WHERE id = ?1", [&s.id]).unwrap();
        assert_eq!(vault.len(), 1);
        sweep(&c, &vault).unwrap();
        assert_eq!(vault.len(), 0);
    }

    #[test]
    fn names_are_validated_and_unique() {
        let c = open_memory();
        let vault = MemoryStore::default();
        let pr = create_project(&c, &ProjectInput { name: "API".into(), ..Default::default() }).unwrap();
        let prof = create_profile(&c, &pr.id, "Dev").unwrap();
        let input = |n: &str| VarInput { profile_id: prof.id.clone(), id: None, name: n.into(), kind: "plain".into(), value: Some("1".into()) };
        assert!(set_var(&c, &vault, &input("BAD-NAME")).is_err());
        set_var(&c, &vault, &input("GOOD_NAME")).unwrap();
        assert!(set_var(&c, &vault, &input("GOOD_NAME")).is_err());
        assert!(looks_secret("STRIPE_SECRET") && looks_secret("GITHUB_TOKEN") && !looks_secret("PORT"));
    }
}
