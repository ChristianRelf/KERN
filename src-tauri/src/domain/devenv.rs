//! Development environment detection and saved project commands.
//!
//! Detection is passive: it reads configuration files (package.json,
//! Cargo.toml, pyproject.toml, …) in a folder and its immediate
//! sub-folders, and looks for tools on PATH. It never runs a program, a
//! package script or an installer. Technologies are only reported from
//! evidence in those files, never guessed from folder names.
//!
//! Saved commands are a program plus an argument list (no shell string), run
//! only when the user starts them, in a trusted folder (see `pty`).

use crate::domain::folders::{self, Trust};
use crate::domain::git::{self, blocking};
use crate::domain::repos;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tech {
    /// Stable id, also used to pick an icon (e.g. "typescript", "vite").
    pub id: String,
    pub name: String,
    /// language | framework | runtime | tool | engine | package-manager
    pub kind: String,
    /// The file that showed it, relative to the root.
    pub evidence: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCommand {
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    /// Working directory relative to the root ("" = root).
    pub cwd: String,
    /// dev | build | test | lint | preview | run | other
    pub category: String,
    pub source: String,
    /// What the script runs (shown for transparency; never executed here).
    pub detail: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub id: String,
    pub name: String,
    pub program: String,
    pub available: bool,
    pub path: Option<String>,
    pub help_url: String,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub root: String,
    pub techs: Vec<Tech>,
    pub package_manager: Option<String>,
    pub commands: Vec<DetectedCommand>,
    pub runtimes: Vec<Runtime>,
    /// Current branch, read from .git/HEAD (no git command).
    pub branch: Option<String>,
    pub scanned_dirs: usize,
}

const SKIP: &[&str] = &["node_modules", "target", "dist", "build", "out", ".git", "vendor", "__pycache__", ".venv", "venv", "coverage", "bin", "obj", "Library", "Temp", "Intermediate", "Saved", "DerivedDataCache"];

fn read_small(p: &Path) -> Option<String> {
    let m = std::fs::metadata(p).ok()?;
    if !m.is_file() || m.len() > 2 * 1024 * 1024 {
        return None;
    }
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).to_string())
}

fn rel_join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn categorize(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n == "dev" || n.starts_with("dev:") || n == "serve" || n == "start:dev" || n == "watch" {
        "dev"
    } else if n == "build" || n.starts_with("build:") || n == "compile" || n == "bundle" {
        "build"
    } else if n == "test" || n.starts_with("test:") || n == "e2e" || n == "coverage" {
        "test"
    } else if n == "lint" || n.starts_with("lint:") || n == "format" || n == "fmt" || n == "typecheck" || n == "check" {
        "lint"
    } else if n == "preview" {
        "preview"
    } else if n == "start" || n == "run" {
        "run"
    } else {
        "other"
    }
}

struct Ctx {
    techs: Vec<Tech>,
    commands: Vec<DetectedCommand>,
    package_manager: Option<String>,
    programs: Vec<&'static str>,
}

impl Ctx {
    fn tech(&mut self, id: &str, name: &str, kind: &str, evidence: &str) {
        if !self.techs.iter().any(|t| t.id == id) {
            self.techs.push(Tech { id: id.into(), name: name.into(), kind: kind.into(), evidence: evidence.into() });
        }
    }
    fn cmd(&mut self, name: &str, program: &str, args: &[&str], cwd: &str, category: &str, source: &str, detail: Option<String>) {
        let c = DetectedCommand { name: name.into(), program: program.into(), args: args.iter().map(|a| a.to_string()).collect(), cwd: cwd.into(), category: category.into(), source: source.into(), detail };
        if !self.commands.contains(&c) {
            self.commands.push(c);
        }
    }
    fn needs(&mut self, program: &'static str) {
        if !self.programs.contains(&program) {
            self.programs.push(program);
        }
    }
}

fn detect_node(ctx: &mut Ctx, dir: &Path, rel: &str) {
    let Some(text) = read_small(&dir.join("package.json")) else { return };
    let ev = rel_join(rel, "package.json");
    let pkg: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    ctx.tech("nodejs", "Node.js", "runtime", &ev);
    ctx.needs("node");
    let has = |name: &str| ["dependencies", "devDependencies", "peerDependencies"].iter().any(|k| pkg.get(k).and_then(|d| d.get(name)).is_some());
    if has("typescript") || dir.join("tsconfig.json").is_file() {
        ctx.tech("typescript", "TypeScript", "language", &ev);
    } else {
        ctx.tech("javascript", "JavaScript", "language", &ev);
    }
    for (dep, id, name) in [
        ("react", "react", "React"),
        ("next", "nextdotjs", "Next.js"),
        ("vite", "vite", "Vite"),
        ("astro", "astro", "Astro"),
        ("electron", "electron", "Electron"),
        ("@tauri-apps/api", "tauri", "Tauri"),
        ("@tauri-apps/cli", "tauri", "Tauri"),
        ("vue", "vuedotjs", "Vue"),
        ("svelte", "svelte", "Svelte"),
        ("@angular/core", "angular", "Angular"),
        ("express", "express", "Express"),
        ("tailwindcss", "tailwindcss", "Tailwind CSS"),
    ] {
        if has(dep) {
            ctx.tech(id, name, "framework", &ev);
        }
    }
    let declared = pkg.get("packageManager").and_then(|p| p.as_str()).and_then(|p| p.split('@').next()).map(String::from);
    let pm = declared.filter(|p| ["npm", "pnpm", "yarn", "bun"].contains(&p.as_str())).unwrap_or_else(|| {
        if dir.join("pnpm-lock.yaml").is_file() {
            "pnpm".into()
        } else if dir.join("yarn.lock").is_file() {
            "yarn".into()
        } else if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() {
            "bun".into()
        } else {
            "npm".into()
        }
    });
    let (pm_id, pm_name, prog): (&str, &str, &'static str) = match pm.as_str() {
        "pnpm" => ("pnpm", "pnpm", "pnpm"),
        "yarn" => ("yarn", "Yarn", "yarn"),
        "bun" => ("bun", "Bun", "bun"),
        _ => ("npm", "npm", "npm"),
    };
    ctx.tech(pm_id, pm_name, "package-manager", &ev);
    ctx.needs(prog);
    if ctx.package_manager.is_none() {
        ctx.package_manager = Some(pm_name.into());
    }
    if let Some(scripts) = pkg.get("scripts").and_then(|s| s.as_object()) {
        for (name, body) in scripts {
            // Lifecycle hooks run implicitly with other commands; don't offer them on their own.
            if name.starts_with("pre") || name.starts_with("post") || name == "prepare" || name == "install" {
                continue;
            }
            let args: Vec<&str> = if prog == "yarn" { vec![name.as_str()] } else { vec!["run", name.as_str()] };
            ctx.cmd(name, prog, &args, rel, categorize(name), &ev, body.as_str().map(String::from));
        }
    }
}

fn toml_doc(p: &Path) -> Option<toml::Table> {
    read_small(p).and_then(|t| t.parse::<toml::Table>().ok())
}

fn detect_rust(ctx: &mut Ctx, dir: &Path, rel: &str) {
    let path = dir.join("Cargo.toml");
    let Some(doc) = toml_doc(&path) else { return };
    let ev = rel_join(rel, "Cargo.toml");
    ctx.tech("rust", "Rust", "language", &ev);
    ctx.tech("cargo", "Cargo", "package-manager", &ev);
    ctx.needs("cargo");
    if doc.contains_key("workspace") {
        ctx.tech("cargo-workspace", "Cargo workspace", "tool", &ev);
    }
    let deps = doc.get("dependencies").and_then(|d| d.as_table());
    if deps.is_some_and(|d| d.contains_key("tauri")) || dir.join("tauri.conf.json").is_file() {
        ctx.tech("tauri", "Tauri", "framework", &ev);
    }
    ctx.cmd("cargo build", "cargo", &["build"], rel, "build", &ev, None);
    ctx.cmd("cargo test", "cargo", &["test"], rel, "test", &ev, None);
    ctx.cmd("cargo check", "cargo", &["check"], rel, "lint", &ev, None);
    if doc.contains_key("package") && (dir.join("src/main.rs").is_file() || doc.contains_key("bin")) {
        ctx.cmd("cargo run", "cargo", &["run"], rel, "run", &ev, None);
    }
}

fn detect_python(ctx: &mut Ctx, dir: &Path, rel: &str) {
    let py = dir.join("pyproject.toml");
    let req = dir.join("requirements.txt");
    let doc = toml_doc(&py);
    if doc.is_none() && !req.is_file() && !dir.join("setup.py").is_file() {
        return;
    }
    let ev = if doc.is_some() { rel_join(rel, "pyproject.toml") } else if req.is_file() { rel_join(rel, "requirements.txt") } else { rel_join(rel, "setup.py") };
    ctx.tech("python", "Python", "language", &ev);
    ctx.needs("python");
    let tool = doc.as_ref().and_then(|d| d.get("tool")).and_then(|t| t.as_table());
    let runner: Option<&'static str> = if dir.join("uv.lock").is_file() || tool.is_some_and(|t| t.contains_key("uv")) {
        ctx.tech("uv", "uv", "package-manager", &ev);
        ctx.needs("uv");
        Some("uv")
    } else if tool.is_some_and(|t| t.contains_key("poetry")) || dir.join("poetry.lock").is_file() {
        ctx.tech("poetry", "Poetry", "package-manager", &ev);
        ctx.needs("poetry");
        Some("poetry")
    } else {
        if req.is_file() {
            ctx.tech("pip", "pip", "package-manager", &rel_join(rel, "requirements.txt"));
        }
        None
    };
    if dir.join(".venv").is_dir() || dir.join("venv").is_dir() {
        ctx.tech("venv", "Virtual environment", "tool", &rel_join(rel, if dir.join(".venv").is_dir() { ".venv" } else { "venv" }));
    }
    let text = read_small(&py).unwrap_or_default() + &read_small(&req).unwrap_or_default();
    for (dep, id, name) in [("django", "django", "Django"), ("flask", "flask", "Flask"), ("fastapi", "fastapi", "FastAPI")] {
        if text.to_ascii_lowercase().contains(dep) {
            ctx.tech(id, name, "framework", &ev);
        }
    }
    if text.contains("pytest") {
        match runner {
            Some(r) => ctx.cmd("pytest", r, &["run", "pytest"], rel, "test", &ev, None),
            None => ctx.cmd("pytest", "python", &["-m", "pytest"], rel, "test", &ev, None),
        }
    }
    if let Some(scripts) = doc.as_ref().and_then(|d| d.get("project")).and_then(|p| p.get("scripts")).and_then(|s| s.as_table()) {
        for name in scripts.keys().take(10) {
            match runner {
                Some(r) => ctx.cmd(name, r, &["run", name], rel, "run", &ev, None),
                None => ctx.cmd(name, name, &[], rel, "run", &ev, None),
            }
        }
    }
}

fn detect_other(ctx: &mut Ctx, dir: &Path, rel: &str) {
    if dir.join("go.mod").is_file() {
        let ev = rel_join(rel, "go.mod");
        ctx.tech("go", "Go", "language", &ev);
        ctx.needs("go");
        ctx.cmd("go build", "go", &["build", "./..."], rel, "build", &ev, None);
        ctx.cmd("go test", "go", &["test", "./..."], rel, "test", &ev, None);
        ctx.cmd("go run", "go", &["run", "."], rel, "run", &ev, None);
    }
    if dir.join("pom.xml").is_file() {
        let ev = rel_join(rel, "pom.xml");
        ctx.tech("openjdk", "Java", "language", &ev);
        ctx.tech("apachemaven", "Maven", "tool", &ev);
        ctx.needs("mvn");
        ctx.cmd("mvn package", "mvn", &["package"], rel, "build", &ev, None);
        ctx.cmd("mvn test", "mvn", &["test"], rel, "test", &ev, None);
    }
    for g in ["build.gradle", "build.gradle.kts"] {
        if dir.join(g).is_file() {
            let ev = rel_join(rel, g);
            ctx.tech(if g.ends_with("kts") { "kotlin" } else { "openjdk" }, if g.ends_with("kts") { "Kotlin" } else { "Java" }, "language", &ev);
            ctx.tech("gradle", "Gradle", "tool", &ev);
            let wrapper = if cfg!(windows) { "gradlew.bat" } else { "gradlew" };
            let prog = if dir.join(wrapper).is_file() { if cfg!(windows) { "gradlew.bat" } else { "./gradlew" } } else { "gradle" };
            if prog == "gradle" {
                ctx.needs("gradle");
            }
            ctx.cmd("gradle build", prog, &["build"], rel, "build", &ev, None);
            ctx.cmd("gradle test", prog, &["test"], rel, "test", &ev, None);
            break;
        }
    }
    if dir.join("CMakeLists.txt").is_file() {
        let ev = rel_join(rel, "CMakeLists.txt");
        ctx.tech("cmake", "CMake", "tool", &ev);
        ctx.needs("cmake");
        ctx.cmd("cmake configure", "cmake", &["-S", ".", "-B", "build"], rel, "build", &ev, None);
        ctx.cmd("cmake build", "cmake", &["--build", "build"], rel, "build", &ev, None);
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        if let Some(p) = names.iter().find(|n| n.ends_with(".csproj") || n.ends_with(".fsproj") || n.ends_with(".sln")) {
            let ev = rel_join(rel, p);
            ctx.tech("dotnet", ".NET", "runtime", &ev);
            ctx.needs("dotnet");
            ctx.cmd("dotnet build", "dotnet", &["build"], rel, "build", &ev, None);
            ctx.cmd("dotnet test", "dotnet", &["test"], rel, "test", &ev, None);
            if !p.ends_with(".sln") {
                ctx.cmd("dotnet run", "dotnet", &["run"], rel, "run", &ev, None);
            }
        }
        if let Some(p) = names.iter().find(|n| n.ends_with(".uproject")) {
            ctx.tech("unrealengine", "Unreal Engine", "engine", &rel_join(rel, p));
        }
        if names.iter().any(|n| n == "Dockerfile" || n.ends_with(".Dockerfile")) {
            ctx.tech("docker", "Docker", "tool", &rel_join(rel, "Dockerfile"));
        }
        if let Some(p) = names.iter().find(|n| ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].contains(&n.as_str())) {
            let ev = rel_join(rel, p);
            ctx.tech("docker", "Docker", "tool", &ev);
            ctx.tech("docker-compose", "Docker Compose", "tool", &ev);
            ctx.needs("docker");
            ctx.cmd("compose up", "docker", &["compose", "up"], rel, "dev", &ev, None);
            ctx.cmd("compose down", "docker", &["compose", "down"], rel, "other", &ev, None);
        }
        if names.iter().any(|n| n == "Makefile") {
            let ev = rel_join(rel, "Makefile");
            ctx.tech("make", "Make", "tool", &ev);
            ctx.needs("make");
            let text = read_small(&dir.join("Makefile")).unwrap_or_default();
            for line in text.lines() {
                if let Some((target, _)) = line.split_once(':') {
                    let t = target.trim();
                    if !t.is_empty() && !line.starts_with(['\t', ' ', '.', '#']) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && !line.contains(":=") {
                        ctx.cmd(&format!("make {t}"), "make", &[t], rel, categorize(t), &ev, None);
                    }
                }
                if ctx.commands.len() > 80 {
                    break;
                }
            }
        }
    }
    if let Some(v) = read_small(&dir.join("ProjectSettings").join("ProjectVersion.txt")) {
        let version = v.lines().find_map(|l| l.strip_prefix("m_EditorVersion:")).map(|s| s.trim().to_string());
        ctx.tech("unity", &format!("Unity{}", version.map(|v| format!(" {v}")).unwrap_or_default()), "engine", &rel_join(rel, "ProjectSettings/ProjectVersion.txt"));
    }
    if let Some(t) = read_small(&dir.join("default.project.json")) {
        if serde_json::from_str::<Value>(&t).ok().is_some_and(|v| v.get("tree").is_some()) {
            let ev = rel_join(rel, "default.project.json");
            ctx.tech("roblox", "Roblox", "engine", &ev);
            ctx.tech("rojo", "Rojo", "tool", &ev);
            ctx.needs("rojo");
            ctx.cmd("rojo serve", "rojo", &["serve"], rel, "dev", &ev, None);
            ctx.cmd("rojo build", "rojo", &["build", "-o", "build.rbxlx"], rel, "build", &ev, None);
        }
    }
    if dir.join("deno.json").is_file() || dir.join("deno.jsonc").is_file() {
        ctx.tech("deno", "Deno", "runtime", &rel_join(rel, "deno.json"));
        ctx.needs("deno");
    }
}

/// Finds an executable on PATH without running it.
pub fn which(program: &str) -> Option<PathBuf> {
    let p = Path::new(program);
    if p.components().count() > 1 {
        return p.is_file().then(|| p.to_path_buf());
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into()).split(';').map(|e| e.to_ascii_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let direct = dir.join(program);
        if !cfg!(windows) && direct.is_file() {
            return Some(direct);
        }
        for e in &exts {
            let c = dir.join(format!("{program}{e}"));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

fn runtime_info(program: &str) -> Runtime {
    let (id, name, url) = match program {
        "node" => ("nodejs", "Node.js", "https://nodejs.org/"),
        "npm" => ("npm", "npm", "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm"),
        "pnpm" => ("pnpm", "pnpm", "https://pnpm.io/installation"),
        "yarn" => ("yarn", "Yarn", "https://yarnpkg.com/getting-started/install"),
        "bun" => ("bun", "Bun", "https://bun.sh/"),
        "cargo" => ("rust", "Rust (cargo)", "https://rustup.rs/"),
        "python" => ("python", "Python", "https://www.python.org/downloads/"),
        "uv" => ("uv", "uv", "https://docs.astral.sh/uv/"),
        "poetry" => ("poetry", "Poetry", "https://python-poetry.org/docs/"),
        "go" => ("go", "Go", "https://go.dev/dl/"),
        "mvn" => ("apachemaven", "Maven", "https://maven.apache.org/install.html"),
        "gradle" => ("gradle", "Gradle", "https://gradle.org/install/"),
        "cmake" => ("cmake", "CMake", "https://cmake.org/download/"),
        "dotnet" => ("dotnet", ".NET SDK", "https://dotnet.microsoft.com/download"),
        "docker" => ("docker", "Docker", "https://docs.docker.com/get-docker/"),
        "deno" => ("deno", "Deno", "https://deno.com/"),
        "rojo" => ("rojo", "Rojo", "https://rojo.space/docs/"),
        "make" => ("make", "Make", "https://www.gnu.org/software/make/"),
        other => (other, other, ""),
    };
    // Python is often installed as `py` (Windows launcher) or `python3`.
    let found = match program {
        "python" => which("python").or_else(|| which("python3")).or_else(|| which("py")),
        p => which(p),
    };
    Runtime { id: id.into(), name: name.into(), program: program.into(), available: found.is_some(), path: found.map(|p| p.to_string_lossy().to_string()), help_url: url.into() }
}

pub fn detect(root: &Path) -> Environment {
    let mut ctx = Ctx { techs: vec![], commands: vec![], package_manager: None, programs: vec![] };
    let mut dirs: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut subs: Vec<_> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.') && !SKIP.contains(&n.as_str()))
            .collect();
        subs.sort();
        for n in subs.into_iter().take(40) {
            dirs.push((root.join(&n), n));
        }
    }
    for (dir, rel) in &dirs {
        detect_node(&mut ctx, dir, rel);
        detect_rust(&mut ctx, dir, rel);
        detect_python(&mut ctx, dir, rel);
        detect_other(&mut ctx, dir, rel);
    }
    // Commands from the root first, then by sub-folder.
    ctx.commands.sort_by(|a, b| (!a.cwd.is_empty()).cmp(&!b.cwd.is_empty()).then(a.cwd.cmp(&b.cwd)));
    let runtimes = ctx.programs.iter().map(|p| runtime_info(p)).collect();
    Environment { root: root.to_string_lossy().to_string(), techs: ctx.techs, package_manager: ctx.package_manager, commands: ctx.commands, runtimes, branch: git::read_head(root), scanned_dirs: dirs.len() }
}

/// The folder a target refers to: a repository's local copy or the
/// project's linked folder. Detection reads files only, so restricted
/// folders are fine.
pub fn target_root(conn: &Connection, project_id: &str, repository_id: Option<&str>) -> AppResult<(PathBuf, Trust)> {
    match repository_id {
        Some(r) => repos::local_root(conn, r),
        None => folders::root_of(conn, project_id),
    }
}

// ------------------------------------------------------------ saved commands

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    pub id: String,
    pub project_id: String,
    pub repository_id: Option<String>,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env_profile_id: Option<String>,
    pub confirm: bool,
    pub pinned: bool,
    pub sort_order: f64,
}

fn map_cmd(r: &Row) -> rusqlite::Result<SavedCommand> {
    let args: String = r.get(5)?;
    Ok(SavedCommand {
        id: r.get(0)?,
        project_id: r.get(1)?,
        repository_id: r.get(2)?,
        name: r.get(3)?,
        program: r.get(4)?,
        args: serde_json::from_str(&args).unwrap_or_default(),
        cwd: r.get(6)?,
        env_profile_id: r.get(7)?,
        confirm: r.get::<_, i64>(8)? != 0,
        pinned: r.get::<_, i64>(9)? != 0,
        sort_order: r.get(10)?,
    })
}

const CMD_SELECT: &str = "SELECT id, project_id, repository_id, name, program, args, cwd, env_profile_id, confirm, pinned, sort_order FROM project_commands";

pub fn command(conn: &Connection, id: &str) -> AppResult<SavedCommand> {
    conn.query_row(&format!("{CMD_SELECT} WHERE id = ?1"), [id], map_cmd).optional()?.ok_or_else(|| AppError::NotFound("Command".into()))
}

pub fn commands(conn: &Connection, project_id: &str) -> AppResult<Vec<SavedCommand>> {
    let mut stmt = conn.prepare(&format!("{CMD_SELECT} WHERE project_id = ?1 ORDER BY pinned DESC, sort_order, name"))?;
    let rows = stmt.query_map([project_id], map_cmd)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Program names are plain names or paths: no shell syntax.
pub fn check_program(program: &str) -> AppResult<()> {
    let p = program.trim();
    if p.is_empty() || p.starts_with('-') || p.contains(['|', '&', ';', '<', '>', '`', '$', '\n', '\r']) {
        return invalid("Enter a program name (like npm or cargo) without shell operators. Put arguments in the arguments field.");
    }
    Ok(())
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandInput {
    pub id: Option<String>,
    pub project_id: String,
    pub repository_id: Option<String>,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env_profile_id: Option<String>,
    pub confirm: bool,
    pub pinned: bool,
}

pub fn save_command(conn: &Connection, input: &CommandInput) -> AppResult<SavedCommand> {
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("Name the command.");
    }
    check_program(&input.program)?;
    let cwd = input.cwd.trim().trim_matches(['/', '\\']).replace('\\', "/");
    if cwd.split('/').any(|s| s == "..") {
        return invalid("The working folder must be inside the project.");
    }
    let now = now_ms();
    let args = serde_json::to_string(&input.args)?;
    let id = match &input.id {
        Some(id) => {
            conn.execute(
                "UPDATE project_commands SET repository_id = ?1, name = ?2, program = ?3, args = ?4, cwd = ?5, env_profile_id = ?6, confirm = ?7, pinned = ?8, updated_at = ?9 WHERE id = ?10",
                params![input.repository_id, name, input.program.trim(), args, cwd, input.env_profile_id, input.confirm as i64, input.pinned as i64, now, id],
            )?;
            id.clone()
        }
        None => {
            let id = new_id();
            let sort: f64 = conn.query_row("SELECT coalesce(max(sort_order), 0) + 1 FROM project_commands WHERE project_id = ?1", [&input.project_id], |r| r.get(0))?;
            conn.execute(
                "INSERT INTO project_commands(id, project_id, repository_id, name, program, args, cwd, env_profile_id, confirm, pinned, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![id, input.project_id, input.repository_id, name, input.program.trim(), args, cwd, input.env_profile_id, input.confirm as i64, input.pinned as i64, sort, now],
            )?;
            id
        }
    };
    command(conn, &id)
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub async fn devenv_detect(app: AppHandle, project_id: String, repository_id: Option<String>) -> AppResult<Environment> {
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| target_root(c, &project_id, repository_id.as_deref()))?;
        let env = detect(&root);
        let key = format!("env:{}", folders::folder_key(&root));
        let _ = s.with(|c| {
            c.execute(
                "INSERT INTO dev_cache(key, data, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
                params![key, serde_json::to_string(&env.techs.iter().map(|t| &t.id).collect::<Vec<_>>())?, now_ms()],
            )?;
            Ok(())
        });
        Ok(env)
    })
    .await
}

#[tauri::command]
pub fn commands_list(state: State<AppState>, project_id: String) -> AppResult<Vec<SavedCommand>> {
    state.with(|c| commands(c, &project_id))
}

#[tauri::command]
pub fn command_save(state: State<AppState>, input: CommandInput) -> AppResult<SavedCommand> {
    state.with(|c| save_command(c, &input))
}

#[tauri::command]
pub fn command_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM project_commands WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn which_program(program: String) -> Option<String> {
    which(&program).map(|p| p.to_string_lossy().to_string())
}

/// Technologies per project from the last detection (cheap; no scanning).
#[tauri::command]
pub fn devenv_cached(state: State<AppState>, project_id: String) -> AppResult<BTreeMap<String, Vec<String>>> {
    state.with(|c| {
        let mut out = BTreeMap::new();
        let mut keys: Vec<(String, String)> = vec![];
        if let Some((_, k)) = c.query_row("SELECT path, folder_key FROM project_folder_links WHERE project_id = ?1", [&project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? {
            keys.push(("folder".into(), k));
        }
        let mut stmt = c.prepare("SELECT id, folder_key FROM project_repositories WHERE project_id = ?1 AND folder_key IS NOT NULL")?;
        for row in stmt.query_map([&project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            keys.push(row?);
        }
        for (id, k) in keys {
            let v: Option<String> = c.query_row("SELECT data FROM dev_cache WHERE key = ?1", [format!("env:{k}")], |r| r.get(0)).optional()?;
            if let Some(v) = v.and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok()) {
                out.insert(id, v);
            }
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_from_config_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::write(
            r.join("package.json"),
            r#"{"packageManager":"pnpm@9.0.0","scripts":{"dev":"vite","build":"tsc && vite build","preinstall":"node evil.js","test":"vitest"},"dependencies":{"react":"^19"},"devDependencies":{"vite":"^7","typescript":"~5.9"}}"#,
        )
        .unwrap();
        std::fs::create_dir(r.join("src-tauri")).unwrap();
        std::fs::write(r.join("src-tauri/Cargo.toml"), "[package]\nname = \"app\"\n[dependencies]\ntauri = \"2\"\n").unwrap();
        std::fs::create_dir(r.join("python")).unwrap(); // a folder name alone proves nothing
        let env = detect(r);
        let ids: Vec<&str> = env.techs.iter().map(|t| t.id.as_str()).collect();
        for want in ["nodejs", "typescript", "react", "vite", "pnpm", "rust", "tauri"] {
            assert!(ids.contains(&want), "missing {want}: {ids:?}");
        }
        assert!(!ids.contains(&"python"));
        assert_eq!(env.package_manager.as_deref(), Some("pnpm"));
        let dev = env.commands.iter().find(|c| c.name == "dev").unwrap();
        assert_eq!((dev.program.as_str(), dev.args.clone(), dev.category.as_str()), ("pnpm", vec!["run".to_string(), "dev".to_string()], "dev"));
        assert!(!env.commands.iter().any(|c| c.name == "preinstall"), "lifecycle hooks aren't offered");
        assert!(env.commands.iter().any(|c| c.name == "cargo test" && c.cwd == "src-tauri"));
    }

    #[test]
    fn rejects_shell_syntax_in_programs() {
        assert!(check_program("npm").is_ok());
        assert!(check_program("C:\\tools\\rojo.exe").is_ok());
        assert!(check_program("npm run dev && rm -rf /").is_err());
        assert!(check_program("--flag").is_err());
    }
}
