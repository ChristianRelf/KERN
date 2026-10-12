//! Integrated terminal: real pseudoterminals (ConPTY on Windows, a pty on
//! macOS/Linux) streamed to the xterm.js renderer.
//!
//! A terminal runs with the user's normal operating-system permissions;
//! workspace trust is not a sandbox. Kern never types into a terminal on its
//! own: shells start empty and saved commands start only when the user runs
//! them. Running a saved or detected command needs a trusted folder, because
//! package scripts and build files can run arbitrary code. Environment
//! profiles are injected into that one process only; nothing is written to
//! the system environment and output is never persisted.

use crate::domain::folders::{self, Trust};
use crate::domain::{devenv, envvars, repos, settings, worktrees};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub cwd: String,
    pub shell: String,
    /// Display form of a command run in this terminal (no secret values).
    pub command: Option<String>,
    pub command_id: Option<String>,
    pub started_at: i64,
    pub exit_code: Option<i64>,
    pub running: bool,
}

struct Handle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    folder_key: String,
    info: PtyInfo,
}

#[derive(Default)]
pub struct PtyManager {
    inner: Mutex<HashMap<String, Handle>>,
}

impl PtyManager {
    pub fn running_count(&self) -> usize {
        self.inner.lock().map(|m| m.values().filter(|h| h.info.running).count()).unwrap_or(0)
    }

    /// Titles of running terminals whose folder is `folder_key` or inside it.
    pub fn users_of(&self, folder_key: &str) -> Vec<String> {
        let sep = std::path::MAIN_SEPARATOR;
        self.inner
            .lock()
            .map(|m| {
                m.values()
                    .filter(|h| h.info.running && (h.folder_key == folder_key || h.folder_key.starts_with(&format!("{folder_key}{sep}"))))
                    .map(|h| format!("terminal “{}”", h.info.title))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        let mut v: Vec<PtyInfo> = self.inner.lock().map(|m| m.values().map(|h| h.info.clone()).collect()).unwrap_or_default();
        v.sort_by_key(|i| i.started_at);
        v
    }

    fn mark_exited(&self, id: &str, code: Option<i64>) {
        if let Ok(mut m) = self.inner.lock() {
            if let Some(h) = m.get_mut(id) {
                h.info.running = false;
                h.info.exit_code = code;
            }
        }
    }

    /// Stops a terminal's process tree (not just the shell).
    fn kill(&self, id: &str) {
        let Ok(mut m) = self.inner.lock() else { return };
        if let Some(h) = m.get_mut(id) {
            if h.info.running {
                kill_tree(h.pid);
                let _ = h.killer.kill();
            }
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.inner.lock().map(|m| m.keys().cloned().collect()).unwrap_or_default();
        for id in ids {
            self.kill(&id);
        }
    }
}

fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        let mut c = crate::domain::git::command("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let _ = c.status();
    }
    #[cfg(unix)]
    {
        // The pty child leads its own session, so its pid is the group id.
        let _ = std::process::Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Shell {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
}

pub fn shells() -> Vec<Shell> {
    let mut out = vec![];
    let mut add = |id: &str, name: &str, program: PathBuf, args: &[&str]| {
        if program.is_file() {
            out.push(Shell { id: id.into(), name: name.into(), program: program.to_string_lossy().to_string(), args: args.iter().map(|a| a.to_string()).collect() });
        }
    };
    #[cfg(windows)]
    {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        if let Some(p) = devenv::which("pwsh") {
            add("pwsh", "PowerShell 7", p, &["-NoLogo"]);
        }
        add("powershell", "Windows PowerShell", PathBuf::from(&sys).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"), &["-NoLogo"]);
        add("cmd", "Command Prompt", PathBuf::from(&sys).join(r"System32\cmd.exe"), &[]);
        for base in [std::env::var("ProgramFiles").ok(), std::env::var("ProgramW6432").ok()].into_iter().flatten() {
            let p = PathBuf::from(base).join(r"Git\bin\bash.exe");
            if p.is_file() {
                add("gitbash", "Git Bash", p, &["--login", "-i"]);
                break;
            }
        }
        add("wsl", "WSL", PathBuf::from(&sys).join(r"System32\wsl.exe"), &[]);
    }
    #[cfg(unix)]
    {
        if let Ok(sh) = std::env::var("SHELL") {
            let name = Path::new(&sh).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "shell".into());
            add("default", &format!("{name} (default)"), PathBuf::from(&sh), &["-l"]);
        }
        add("zsh", "zsh", PathBuf::from("/bin/zsh"), &["-l"]);
        add("bash", "bash", PathBuf::from("/bin/bash"), &["-l"]);
        add("fish", "fish", PathBuf::from("/usr/bin/fish"), &["-l"]);
        add("fish", "fish", PathBuf::from("/opt/homebrew/bin/fish"), &["-l"]);
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));
    out
}

/// Where a terminal starts.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum CwdTarget {
    /// The project's linked folder (optionally a sub-folder).
    Project { project_id: String, rel: Option<String> },
    /// A repository's local copy (optionally a sub-folder).
    Repository { repository_id: String, rel: Option<String> },
    /// A worktree of a repository.
    Worktree { repository_id: String, path: String },
    /// The user's configured default location (or home).
    Default,
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Resolves a start folder and its trust (re-verified, never escaping a linked root).
fn resolve_cwd(state: &AppState, target: &CwdTarget) -> AppResult<(PathBuf, Trust)> {
    let sub = |root: PathBuf, rel: &Option<String>| -> AppResult<PathBuf> {
        match rel.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            Some(r) => folders::resolve_inside(&root, r),
            None => Ok(root),
        }
    };
    match target {
        CwdTarget::Project { project_id, rel } => {
            let (root, trust) = state.with(|c| folders::root_of(c, project_id))?;
            Ok((sub(root, rel)?, trust))
        }
        CwdTarget::Repository { repository_id, rel } => {
            let (root, trust) = state.with(|c| repos::local_root(c, repository_id))?;
            Ok((sub(root, rel)?, trust))
        }
        CwdTarget::Worktree { repository_id, path } => {
            let key = folders::folder_key(&folders::canonical(Path::new(path))?);
            let w = worktrees::list(state, repository_id, false)?
                .into_iter()
                .find(|w| folders::canonical(Path::new(&w.path)).map(|c| folders::folder_key(&c) == key).unwrap_or(false))
                .ok_or_else(|| AppError::NotFound("That worktree".into()))?;
            let canon = folders::canonical(Path::new(&w.path))?;
            let trust = state.with(|c| folders::trust_of(c, &key))?.or(w.trust).unwrap_or(Trust::Restricted);
            Ok((canon, trust))
        }
        CwdTarget::Default => {
            let configured: String = state.with(|c| Ok(settings::get_or(c, "terminal.defaultCwd", String::new())))?;
            let p = PathBuf::from(configured.trim());
            Ok((if !configured.trim().is_empty() && p.is_dir() { p } else { home() }, Trust::Restricted))
        }
    }
}

/// What to run instead of an interactive shell.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    /// A saved command (its program, arguments, folder and profile are used).
    pub command_id: Option<String>,
    /// Or an ad-hoc command, e.g. a detected package script.
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub env_profile_id: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpawnInput {
    pub cwd: CwdTarget,
    pub shell: Option<String>,
    pub run: Option<RunSpec>,
    pub project_id: Option<String>,
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Splits complete UTF-8 from a trailing partial character.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let s = s.to_string();
            buf.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let s = String::from_utf8_lossy(&buf[..valid]).to_string();
            buf.drain(..valid);
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(buf).to_string();
            buf.clear();
            s
        }
    }
}

#[derive(Serialize, Clone)]
struct DataEvent<'a> {
    id: &'a str,
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent<'a> {
    id: &'a str,
    code: Option<i64>,
}

pub fn spawn(app: &AppHandle, input: SpawnInput) -> AppResult<PtyInfo> {
    let state = app.state::<AppState>();
    let mut cwd_target = input.cwd.clone();
    // A saved command carries its own folder (repository or project).
    let saved = match input.run.as_ref().and_then(|r| r.command_id.clone()) {
        Some(id) => Some(state.with(|c| devenv::command(c, &id))?),
        None => None,
    };
    if let Some(c) = &saved {
        let rel = (!c.cwd.is_empty()).then(|| c.cwd.clone());
        cwd_target = match &c.repository_id {
            Some(r) => CwdTarget::Repository { repository_id: r.clone(), rel },
            None => CwdTarget::Project { project_id: c.project_id.clone(), rel },
        };
    }
    let (cwd, trust) = resolve_cwd(&state, &cwd_target)?;
    if !cwd.is_dir() {
        return invalid("That folder isn't available.");
    }
    let shells = shells();
    let shell = match &input.shell {
        Some(id) => shells.iter().find(|s| &s.id == id).cloned(),
        None => {
            let pref: String = state.with(|c| Ok(settings::get_or(c, "terminal.shell", String::new())))?;
            shells.iter().find(|s| s.id == pref).or_else(|| shells.first()).cloned()
        }
    }
    .ok_or_else(|| AppError::Invalid("No supported shell was found on this computer.".into()))?;

    let mut env: Vec<(String, String)> = vec![];
    let (mut cmd, display, command_id) = match (&saved, &input.run) {
        (Some(c), run) => {
            if trust != Trust::Trusted {
                return invalid("Running project commands needs a trusted folder, because package scripts and build files can run any code. Trust the folder first.");
            }
            let profile = run.as_ref().and_then(|r| r.env_profile_id.clone()).or_else(|| c.env_profile_id.clone());
            if let Some(p) = profile {
                env = state.with(|conn| envvars::resolve(conn, state.ai.vault.as_ref(), &p))?;
            }
            let mut b = CommandBuilder::new(&c.program);
            b.args(&c.args);
            (b, Some(format!("{} {}", c.program, c.args.join(" ")).trim().to_string()), Some(c.id.clone()))
        }
        (None, Some(run)) if run.program.is_some() => {
            let program = run.program.clone().unwrap_or_default();
            devenv::check_program(&program)?;
            if trust != Trust::Trusted {
                return invalid("Running project commands needs a trusted folder, because package scripts and build files can run any code. Trust the folder first.");
            }
            if let Some(p) = &run.env_profile_id {
                env = state.with(|conn| envvars::resolve(conn, state.ai.vault.as_ref(), p))?;
            }
            let mut b = CommandBuilder::new(&program);
            b.args(&run.args);
            (b, Some(format!("{program} {}", run.args.join(" ")).trim().to_string()), None)
        }
        _ => {
            let mut b = CommandBuilder::new(&shell.program);
            b.args(&shell.args);
            if let Some(p) = input.run.as_ref().and_then(|r| r.env_profile_id.clone()) {
                env = state.with(|conn| envvars::resolve(conn, state.ai.vault.as_ref(), &p))?;
            }
            (b, None, None)
        }
    };
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Kern");
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows: input.rows.clamp(2, 500), cols: input.cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| AppError::Other(format!("Couldn't open a terminal ({e}).")))?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        AppError::Invalid(match &display {
            Some(d) => format!("Couldn't start “{d}”: {e}. Is the program installed and on PATH?"),
            None => format!("Couldn't start {} ({e}).", shell.name),
        })
    })?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| AppError::Other(e.to_string()))?;
    let writer = pair.master.take_writer().map_err(|e| AppError::Other(e.to_string()))?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    let id = new_id();
    let folder_name = cwd.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| cwd.to_string_lossy().to_string());
    let info = PtyInfo {
        id: id.clone(),
        title: input.title.clone().filter(|t| !t.trim().is_empty()).or_else(|| saved.as_ref().map(|c| c.name.clone())).or_else(|| display.clone()).unwrap_or(folder_name),
        project_id: input.project_id.clone().or_else(|| saved.as_ref().map(|c| c.project_id.clone())),
        cwd: cwd.to_string_lossy().to_string(),
        shell: if display.is_some() { "command".into() } else { shell.id.clone() },
        command: display,
        command_id,
        started_at: now_ms(),
        exit_code: None,
        running: true,
    };
    state.pty.inner.lock().map_err(|_| AppError::Other("Terminal state is unavailable.".into()))?.insert(
        id.clone(),
        Handle { writer, master: pair.master, killer, pid, folder_key: folders::folder_key(&cwd), info: info.clone() },
    );

    // Output pump: one thread per terminal, blocking reads, no polling.
    let out_app = app.clone();
    let out_id = id.clone();
    std::thread::Builder::new()
        .name("kern-pty-read".into())
        .spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 16 * 1024];
            let mut pending: Vec<u8> = vec![];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = take_utf8(&mut pending);
                        if !data.is_empty() {
                            let _ = out_app.emit("kern://pty-data", DataEvent { id: &out_id, data });
                        }
                    }
                }
            }
        })
        .map_err(|e| AppError::Other(e.to_string()))?;
    // Exit watcher.
    let exit_app = app.clone();
    std::thread::Builder::new()
        .name("kern-pty-wait".into())
        .spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i64);
            exit_app.state::<AppState>().pty.mark_exited(&id, code);
            let _ = exit_app.emit("kern://pty-exit", ExitEvent { id: &id, code });
        })
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(info)
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn pty_shells() -> Vec<Shell> {
    shells()
}

#[tauri::command]
pub async fn pty_spawn(app: AppHandle, input: SpawnInput) -> AppResult<PtyInfo> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || spawn(&handle, input)).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn pty_write(state: tauri::State<AppState>, id: String, data: String) -> AppResult<()> {
    let mut m = state.pty.inner.lock().map_err(|_| AppError::Other("Terminal state is unavailable.".into()))?;
    let h = m.get_mut(&id).ok_or_else(|| AppError::NotFound("Terminal".into()))?;
    if !h.info.running {
        return Ok(());
    }
    h.writer.write_all(data.as_bytes())?;
    h.writer.flush()?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<AppState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    let m = state.pty.inner.lock().map_err(|_| AppError::Other("Terminal state is unavailable.".into()))?;
    if let Some(h) = m.get(&id) {
        let _ = h.master.resize(PtySize { rows: rows.clamp(2, 500), cols: cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 });
    }
    Ok(())
}

/// Stops the process (and its children) but keeps the tab's output.
#[tauri::command]
pub fn pty_kill(state: tauri::State<AppState>, id: String) {
    state.pty.kill(&id);
}

/// Stops the process if needed and forgets the terminal.
#[tauri::command]
pub fn pty_close(state: tauri::State<AppState>, id: String) {
    state.pty.kill(&id);
    if let Ok(mut m) = state.pty.inner.lock() {
        m.remove(&id);
    }
}

#[tauri::command]
pub fn pty_list(state: tauri::State<AppState>) -> Vec<PtyInfo> {
    state.pty.list()
}

#[tauri::command]
pub fn pty_rename(state: tauri::State<AppState>, id: String, title: String) -> AppResult<()> {
    let t = title.trim();
    if t.is_empty() {
        return invalid("Name the terminal.");
    }
    if let Ok(mut m) = state.pty.inner.lock() {
        if let Some(h) = m.get_mut(&id) {
            h.info.title = t.chars().take(80).collect();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_is_split_on_character_boundaries() {
        let bytes = "héllo ✓".as_bytes();
        let mut buf = bytes[..bytes.len() - 1].to_vec();
        let first = take_utf8(&mut buf);
        assert_eq!(first, "héllo ");
        buf.push(bytes[bytes.len() - 1]);
        assert_eq!(take_utf8(&mut buf), "✓");
        assert!(buf.is_empty());
    }

    #[test]
    fn start_folders_deserialize_from_the_frontend() {
        let t: CwdTarget = serde_json::from_str(r#"{"kind":"repository","repositoryId":"r1","rel":null}"#).unwrap();
        assert!(matches!(t, CwdTarget::Repository { ref repository_id, .. } if repository_id == "r1"));
        let t: CwdTarget = serde_json::from_str(r#"{"kind":"worktree","repositoryId":"r1","path":"C:/x"}"#).unwrap();
        assert!(matches!(t, CwdTarget::Worktree { .. }));
        let t: CwdTarget = serde_json::from_str(r#"{"kind":"project","projectId":"p1"}"#).unwrap();
        assert!(matches!(t, CwdTarget::Project { ref project_id, .. } if project_id == "p1"));
        assert!(matches!(serde_json::from_str::<CwdTarget>(r#"{"kind":"default"}"#).unwrap(), CwdTarget::Default));
    }

    #[test]
    fn finds_at_least_one_shell() {
        assert!(!shells().is_empty());
    }
}
