// @Author Christian Relf
// @Date 2026-10-12

//! Dependency explorer: what a project depends on, read from manifests and
//! lockfiles (npm, pnpm, Yarn, Cargo, Python, Go, Maven/Gradle, .NET).
//!
//! A declared range ("^18.2.0") is never presented as an installed version:
//! `resolved` is only set from a lockfile (or an exact pin where the
//! ecosystem resolves to exactly that). Advisory lookups (OSV) are optional,
//! explicit, need the network setting, and only check resolved versions; a
//! clean result is reported as "no known advisories", never as "secure".
//! Nothing is installed or upgraded from here.

use crate::domain::devenv;
use crate::domain::folders;
use crate::domain::git::blocking;
use crate::domain::settings;
use crate::error::{invalid, AppError, AppResult};
use crate::util::now_ms;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;

const MAX_PACKAGES: usize = 20_000;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    /// OSV ecosystem name: npm, crates.io, PyPI, Go, Maven, NuGet.
    pub ecosystem: String,
    pub declared: Option<String>,
    pub resolved: Option<String>,
    /// Some(true) direct, Some(false) transitive, None when unknown.
    pub direct: Option<bool>,
    /// prod | dev | peer | optional | build
    pub group: String,
    /// The manifest it came from, relative to the root.
    pub manifest: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub path: String,
    pub ecosystem: String,
    pub lockfile: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub root: String,
    pub scanned_at: i64,
    pub manifests: Vec<Manifest>,
    pub packages: Vec<Package>,
    /// (from, to) as "ecosystem:name@version" keys, where a lockfile says so.
    pub edges: Vec<(String, String)>,
    pub truncated: bool,
}

fn key(eco: &str, name: &str, version: &str) -> String {
    format!("{eco}:{name}@{version}")
}

fn read(p: &Path) -> Option<String> {
    let m = std::fs::metadata(p).ok()?;
    if !m.is_file() || m.len() > 64 * 1024 * 1024 {
        return None;
    }
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).to_string())
}

fn rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.into()
    } else {
        format!("{dir}/{name}")
    }
}

struct Acc {
    packages: Vec<Package>,
    index: HashMap<(String, String, String), usize>,
    edges: Vec<(String, String)>,
    truncated: bool,
}

impl Acc {
    fn add(&mut self, p: Package) {
        if self.packages.len() >= MAX_PACKAGES {
            self.truncated = true;
            return;
        }
        let k = (p.ecosystem.clone(), p.name.clone(), p.resolved.clone().unwrap_or_else(|| format!("~{}", p.declared.clone().unwrap_or_default())));
        match self.index.get(&k) {
            Some(&i) => {
                let e = &mut self.packages[i];
                if p.direct == Some(true) {
                    e.direct = Some(true);
                    e.group = p.group;
                    e.declared = p.declared.or(e.declared.take());
                }
            }
            None => {
                self.index.insert(k, self.packages.len());
                self.packages.push(p);
            }
        }
    }
    fn edge(&mut self, a: String, b: String) {
        if self.edges.len() < 100_000 {
            self.edges.push((a, b));
        }
    }
}

// ------------------------------------------------------------ npm family

fn node_declared(pkg: &Value) -> Vec<(String, String, &'static str)> {
    let mut out = vec![];
    for (field, group) in [("dependencies", "prod"), ("devDependencies", "dev"), ("peerDependencies", "peer"), ("optionalDependencies", "optional")] {
        if let Some(m) = pkg.get(field).and_then(|d| d.as_object()) {
            for (n, v) in m {
                out.push((n.clone(), v.as_str().unwrap_or("").to_string(), group));
            }
        }
    }
    out
}

fn scan_npm(acc: &mut Acc, dir: &Path, d: &str, manifests: &mut Vec<Manifest>) {
    let Some(text) = read(&dir.join("package.json")) else { return };
    let pkg: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let manifest = rel(d, "package.json");
    let declared = node_declared(&pkg);
    let declared_map: HashMap<&str, (&str, &str)> = declared.iter().map(|(n, v, g)| (n.as_str(), (v.as_str(), *g))).collect();
    let eco = "npm";
    let mut resolved_direct: HashMap<String, String> = HashMap::new();
    let mut lock = None;
    if let Some(lt) = read(&dir.join("package-lock.json")) {
        lock = Some("package-lock.json");
        let l: Value = serde_json::from_str(&lt).unwrap_or(Value::Null);
        if let Some(pkgs) = l.get("packages").and_then(|p| p.as_object()) {
            for (path, info) in pkgs {
                let Some(name) = path.rsplit("node_modules/").next().filter(|_| path.contains("node_modules/")) else { continue };
                let Some(version) = info.get("version").and_then(|v| v.as_str()) else { continue };
                let top = path.matches("node_modules/").count() == 1 && path.starts_with("node_modules/");
                let direct = top && declared_map.contains_key(name);
                if direct {
                    resolved_direct.insert(name.to_string(), version.to_string());
                }
                let group = if info.get("dev").and_then(|b| b.as_bool()) == Some(true) { "dev" } else if info.get("optional").and_then(|b| b.as_bool()) == Some(true) { "optional" } else { "prod" };
                acc.add(Package {
                    name: name.to_string(),
                    ecosystem: eco.into(),
                    declared: if direct { declared_map.get(name).map(|(v, _)| v.to_string()) } else { None },
                    resolved: Some(version.to_string()),
                    direct: Some(direct),
                    group: if direct { declared_map[name].1.to_string() } else { group.into() },
                    manifest: manifest.clone(),
                });
                for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
                    if let Some(deps) = info.get(field).and_then(|x| x.as_object()) {
                        for dep in deps.keys() {
                            // Node resolution: the nearest node_modules wins; approximate with the top-level copy.
                            let nested = format!("{path}/node_modules/{dep}");
                            let target = pkgs.get(&nested).or_else(|| pkgs.get(&format!("node_modules/{dep}")));
                            if let Some(v) = target.and_then(|t| t.get("version")).and_then(|v| v.as_str()) {
                                acc.edge(key(eco, name, version), key(eco, dep, v));
                            }
                        }
                    }
                }
            }
        }
    } else if let Some(lt) = read(&dir.join("pnpm-lock.yaml")) {
        lock = Some("pnpm-lock.yaml");
        parse_pnpm(acc, &lt, &declared_map, &manifest, &mut resolved_direct);
    } else if let Some(lt) = read(&dir.join("yarn.lock")) {
        lock = Some("yarn.lock");
        parse_yarn(acc, &lt, &declared, &manifest, &mut resolved_direct);
    }
    // Root edges and any direct dependency the lockfile didn't cover.
    let root = key(eco, pkg.get("name").and_then(|n| n.as_str()).unwrap_or("(project)"), pkg.get("version").and_then(|n| n.as_str()).unwrap_or("0.0.0"));
    for (n, v, g) in &declared {
        let resolved = resolved_direct.get(n).cloned();
        if let Some(r) = &resolved {
            acc.edge(root.clone(), key(eco, n, r));
        } else {
            acc.add(Package { name: n.clone(), ecosystem: eco.into(), declared: Some(v.clone()), resolved: None, direct: Some(true), group: (*g).into(), manifest: manifest.clone() });
        }
    }
    manifests.push(Manifest { path: manifest, ecosystem: eco.into(), lockfile: lock.map(|l| rel(d, l)) });
}

/// pnpm-lock.yaml (v6 and v9): direct versions from `importers: .:`, every
/// package from `packages:` keys, and edges from `snapshots:`/`packages:`.
fn parse_pnpm(acc: &mut Acc, text: &str, declared: &HashMap<&str, (&str, &str)>, manifest: &str, resolved_direct: &mut HashMap<String, String>) {
    let split_key = |k: &str| -> Option<(String, String)> {
        let k = k.trim().trim_matches(['\'', '"']).trim_start_matches('/');
        let k = k.split('(').next().unwrap_or(k);
        let at = k[1..].find('@').map(|i| i + 1)?;
        Some((k[..at].to_string(), k[at + 1..].to_string()))
    };
    let mut section = "";
    let mut importer = String::new();
    let mut dep_name = String::new();
    let mut cur_pkg: Option<(String, String)> = None;
    let mut in_deps = false;
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let t = line.trim();
        if indent == 0 {
            section = match t {
                "importers:" => "importers",
                "packages:" => "packages",
                "snapshots:" => "snapshots",
                "dependencies:" | "devDependencies:" => "rootdeps",
                _ => "",
            };
            continue;
        }
        match section {
            "importers" => {
                if indent == 2 {
                    importer = t.trim_end_matches(':').to_string();
                } else if importer == "." && indent == 6 {
                    dep_name = t.trim_end_matches(':').trim_matches(['\'', '"']).to_string();
                } else if importer == "." && indent == 8 && t.starts_with("version:") {
                    let v = t["version:".len()..].trim().split('(').next().unwrap_or("").trim_matches(['\'', '"']).to_string();
                    resolved_direct.insert(dep_name.clone(), v);
                }
            }
            "rootdeps" if indent == 2 => {
                // v5: "  react: 18.2.0"
                if let Some((n, v)) = t.split_once(':') {
                    resolved_direct.insert(n.trim().trim_matches(['\'', '"']).to_string(), v.trim().split('(').next().unwrap_or("").trim_matches(['\'', '"']).to_string());
                }
            }
            "packages" | "snapshots" => {
                if indent == 2 {
                    cur_pkg = split_key(t.trim_end_matches(':'));
                    in_deps = false;
                    if section == "packages" {
                        if let Some((n, v)) = &cur_pkg {
                            let direct = resolved_direct.get(n) == Some(v);
                            acc.add(Package {
                                name: n.clone(),
                                ecosystem: "npm".into(),
                                declared: if direct { declared.get(n.as_str()).map(|(d, _)| d.to_string()) } else { None },
                                resolved: Some(v.clone()),
                                direct: Some(direct),
                                group: if direct { declared.get(n.as_str()).map(|(_, g)| g.to_string()).unwrap_or_else(|| "prod".into()) } else { "prod".into() },
                                manifest: manifest.to_string(),
                            });
                        }
                    }
                } else if indent == 4 {
                    in_deps = t == "dependencies:" || t == "optionalDependencies:";
                } else if indent == 6 && in_deps {
                    if let (Some((pn, pv)), Some((dn, dv))) = (&cur_pkg, t.split_once(':')) {
                        let dv = dv.trim().split('(').next().unwrap_or("").trim_matches(['\'', '"']);
                        acc.edge(key("npm", pn, pv), key("npm", dn.trim().trim_matches(['\'', '"']), dv));
                    }
                }
            }
            _ => {}
        }
    }
}

/// yarn.lock, classic (v1) and Berry formats.
fn parse_yarn(acc: &mut Acc, text: &str, declared: &[(String, String, &'static str)], manifest: &str, resolved_direct: &mut HashMap<String, String>) {
    struct Block {
        specs: Vec<String>,
        version: Option<String>,
        deps: Vec<(String, String)>,
    }
    let mut blocks: Vec<Block> = vec![];
    let mut in_deps = false;
    for line in text.lines() {
        if line.trim().is_empty() || line.starts_with('#') || line.starts_with("__metadata") {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let t = line.trim();
        if indent == 0 && t.ends_with(':') {
            let specs = t.trim_end_matches(':').split(", ").map(|s| s.trim_matches('"').to_string()).collect();
            blocks.push(Block { specs, version: None, deps: vec![] });
            in_deps = false;
        } else if let Some(b) = blocks.last_mut() {
            if indent == 2 {
                in_deps = t == "dependencies:" || t == "optionalDependencies:";
                if let Some(v) = t.strip_prefix("version ").or_else(|| t.strip_prefix("version: ")) {
                    b.version = Some(v.trim().trim_matches('"').to_string());
                }
            } else if indent == 4 && in_deps {
                let (n, r) = t.split_once(": ").or_else(|| t.split_once(' ')).unwrap_or((t, ""));
                b.deps.push((n.trim_matches('"').to_string(), r.trim().trim_matches('"').to_string()));
            }
        }
    }
    // spec ("name@range") → version
    let name_of = |spec: &str| -> String {
        let at = spec[1..].find('@').map(|i| i + 1).unwrap_or(spec.len());
        spec[..at].to_string()
    };
    let mut by_spec: HashMap<String, String> = HashMap::new();
    for b in &blocks {
        if let Some(v) = &b.version {
            for s in &b.specs {
                by_spec.insert(s.replace("@npm:", "@"), v.clone());
            }
        }
    }
    let direct_names: HashMap<&str, (&str, &str)> = declared.iter().map(|(n, v, g)| (n.as_str(), (v.as_str(), *g))).collect();
    for (n, range, _) in declared {
        if let Some(v) = by_spec.get(&format!("{n}@{range}")) {
            resolved_direct.insert(n.clone(), v.clone());
        }
    }
    for b in &blocks {
        let (Some(v), Some(first)) = (&b.version, b.specs.first()) else { continue };
        let n = name_of(first);
        let direct = resolved_direct.get(&n) == Some(v);
        acc.add(Package {
            name: n.clone(),
            ecosystem: "npm".into(),
            declared: if direct { direct_names.get(n.as_str()).map(|(d, _)| d.to_string()) } else { None },
            resolved: Some(v.clone()),
            direct: Some(direct),
            group: if direct { direct_names.get(n.as_str()).map(|(_, g)| g.to_string()).unwrap_or_else(|| "prod".into()) } else { "prod".into() },
            manifest: manifest.to_string(),
        });
        for (dn, dr) in &b.deps {
            if let Some(dv) = by_spec.get(&format!("{dn}@{}", dr.trim_start_matches("npm:"))) {
                acc.edge(key("npm", &n, v), key("npm", dn, dv));
            }
        }
    }
}

// ------------------------------------------------------------ Rust

fn scan_cargo(acc: &mut Acc, dir: &Path, d: &str, manifests: &mut Vec<Manifest>) {
    let Some(doc) = read(&dir.join("Cargo.toml")).and_then(|t| t.parse::<toml::Table>().ok()) else { return };
    let manifest = rel(d, "Cargo.toml");
    let eco = "crates.io";
    let mut declared: Vec<(String, String, &str)> = vec![];
    for (field, group) in [("dependencies", "prod"), ("dev-dependencies", "dev"), ("build-dependencies", "build")] {
        if let Some(t) = doc.get(field).and_then(|x| x.as_table()) {
            for (n, v) in t {
                let ver = match v {
                    toml::Value::String(s) => s.clone(),
                    toml::Value::Table(t) => t.get("version").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(|| if t.contains_key("path") { "path".into() } else if t.contains_key("git") { "git".into() } else { "workspace".into() }),
                    _ => String::new(),
                };
                let real = match v {
                    toml::Value::Table(t) => t.get("package").and_then(|x| x.as_str()).unwrap_or(n).to_string(),
                    _ => n.clone(),
                };
                declared.push((real, ver, group));
            }
        }
    }
    let lock_path = dir.join("Cargo.lock");
    let lock = read(&lock_path).and_then(|t| t.parse::<toml::Table>().ok());
    let mut resolved_direct: HashMap<String, String> = HashMap::new();
    if let Some(l) = &lock {
        let pkgs = l.get("package").and_then(|p| p.as_array()).cloned().unwrap_or_default();
        let mut versions: HashMap<String, Vec<String>> = HashMap::new();
        for p in &pkgs {
            if let (Some(n), Some(v)) = (p.get("name").and_then(|x| x.as_str()), p.get("version").and_then(|x| x.as_str())) {
                versions.entry(n.into()).or_default().push(v.into());
            }
        }
        let locals: HashSet<String> = pkgs.iter().filter(|p| p.get("source").is_none()).filter_map(|p| p.get("name").and_then(|x| x.as_str()).map(String::from)).collect();
        // Direct = dependencies of local (workspace) packages.
        let mut direct: HashSet<(String, String)> = HashSet::new();
        for p in &pkgs {
            let (Some(n), Some(v)) = (p.get("name").and_then(|x| x.as_str()), p.get("version").and_then(|x| x.as_str())) else { continue };
            for dep in p.get("dependencies").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                let s = dep.as_str().unwrap_or("");
                let mut parts = s.split(' ');
                let dn = parts.next().unwrap_or("");
                let dv = parts.next().map(String::from).or_else(|| versions.get(dn).and_then(|v| (v.len() == 1).then(|| v[0].clone())));
                if let Some(dv) = dv {
                    acc.edge(key(eco, n, v), key(eco, dn, &dv));
                    if locals.contains(n) && !locals.contains(dn) {
                        direct.insert((dn.to_string(), dv));
                    }
                }
            }
        }
        for p in &pkgs {
            let (Some(n), Some(v)) = (p.get("name").and_then(|x| x.as_str()), p.get("version").and_then(|x| x.as_str())) else { continue };
            if locals.contains(n) {
                continue;
            }
            let is_direct = direct.contains(&(n.to_string(), v.to_string()));
            let decl = declared.iter().find(|(dn, _, _)| dn == n);
            if is_direct {
                resolved_direct.insert(n.into(), v.into());
            }
            acc.add(Package {
                name: n.into(),
                ecosystem: eco.into(),
                declared: if is_direct { decl.map(|x| x.1.clone()) } else { None },
                resolved: Some(v.into()),
                direct: Some(is_direct),
                group: if is_direct { decl.map(|x| x.2.to_string()).unwrap_or_else(|| "prod".into()) } else { "prod".into() },
                manifest: manifest.clone(),
            });
        }
    }
    for (n, v, g) in &declared {
        if !resolved_direct.contains_key(n) && v != "path" && v != "workspace" {
            acc.add(Package { name: n.clone(), ecosystem: eco.into(), declared: Some(v.clone()), resolved: None, direct: Some(true), group: (*g).into(), manifest: manifest.clone() });
        }
    }
    manifests.push(Manifest { path: manifest, ecosystem: eco.into(), lockfile: lock.map(|_| rel(d, "Cargo.lock")) });
}

// ------------------------------------------------------------ Python

/// "requests>=2.31; python_version>'3.8'" → ("requests", ">=2.31")
fn pep508(spec: &str) -> Option<(String, String)> {
    let s = spec.split(';').next()?.trim();
    let end = s.find(|c: char| !(c.is_ascii_alphanumeric() || "-_.".contains(c))).unwrap_or(s.len());
    let name = &s[..end];
    if name.is_empty() {
        return None;
    }
    let rest = s[end..].trim();
    let rest = if rest.starts_with('[') { rest.split_once(']').map(|(_, r)| r).unwrap_or("").trim() } else { rest };
    Some((name.to_lowercase().replace('_', "-"), rest.trim_start_matches('(').trim_end_matches(')').to_string()))
}

fn scan_python(acc: &mut Acc, dir: &Path, d: &str, manifests: &mut Vec<Manifest>) {
    let eco = "PyPI";
    let mut declared: Vec<(String, String, String)> = vec![];
    let mut manifest = None;
    if let Some(doc) = read(&dir.join("pyproject.toml")).and_then(|t| t.parse::<toml::Table>().ok()) {
        manifest = Some(rel(d, "pyproject.toml"));
        let project = doc.get("project");
        for s in project.and_then(|p| p.get("dependencies")).and_then(|x| x.as_array()).cloned().unwrap_or_default() {
            if let Some((n, v)) = s.as_str().and_then(pep508) {
                declared.push((n, v, "prod".into()));
            }
        }
        if let Some(opt) = project.and_then(|p| p.get("optional-dependencies")).and_then(|x| x.as_table()) {
            for list in opt.values() {
                for s in list.as_array().cloned().unwrap_or_default() {
                    if let Some((n, v)) = s.as_str().and_then(pep508) {
                        declared.push((n, v, "optional".into()));
                    }
                }
            }
        }
        if let Some(groups) = doc.get("dependency-groups").and_then(|x| x.as_table()) {
            for list in groups.values() {
                for s in list.as_array().cloned().unwrap_or_default() {
                    if let Some((n, v)) = s.as_str().and_then(pep508) {
                        declared.push((n, v, "dev".into()));
                    }
                }
            }
        }
        let poetry = doc.get("tool").and_then(|t| t.get("poetry"));
        let mut poetry_tables: Vec<(&toml::Value, &str)> = vec![];
        if let Some(t) = poetry.and_then(|p| p.get("dependencies")) {
            poetry_tables.push((t, "prod"));
        }
        if let Some(t) = poetry.and_then(|p| p.get("dev-dependencies")) {
            poetry_tables.push((t, "dev"));
        }
        if let Some(groups) = poetry.and_then(|p| p.get("group")).and_then(|g| g.as_table()) {
            for g in groups.values() {
                if let Some(t) = g.get("dependencies") {
                    poetry_tables.push((t, "dev"));
                }
            }
        }
        for (t, group) in poetry_tables {
            for (n, v) in t.as_table().cloned().unwrap_or_default() {
                if n == "python" {
                    continue;
                }
                let ver = match &v {
                    toml::Value::String(s) => s.clone(),
                    toml::Value::Table(t) => t.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    _ => String::new(),
                };
                declared.push((n.to_lowercase().replace('_', "-"), ver, group.into()));
            }
        }
    }
    if let Some(t) = read(&dir.join("requirements.txt")) {
        manifest.get_or_insert_with(|| rel(d, "requirements.txt"));
        for line in t.lines() {
            let l = line.split('#').next().unwrap_or("").trim();
            if l.is_empty() || l.starts_with('-') {
                continue;
            }
            if let Some((n, v)) = pep508(l) {
                declared.push((n, v, "prod".into()));
            }
        }
    }
    let Some(manifest) = manifest else { return };
    let mut lockfile = None;
    let mut resolved: HashMap<String, String> = HashMap::new();
    for lname in ["uv.lock", "poetry.lock"] {
        let Some(l) = read(&dir.join(lname)).and_then(|t| t.parse::<toml::Table>().ok()) else { continue };
        lockfile = Some(rel(d, lname));
        let pkgs = l.get("package").and_then(|p| p.as_array()).cloned().unwrap_or_default();
        for p in &pkgs {
            if let (Some(n), Some(v)) = (p.get("name").and_then(|x| x.as_str()), p.get("version").and_then(|x| x.as_str())) {
                resolved.insert(n.to_lowercase().replace('_', "-"), v.into());
            }
        }
        let direct_names: HashSet<String> = declared.iter().map(|x| x.0.clone()).collect();
        for p in &pkgs {
            let (Some(n), Some(v)) = (p.get("name").and_then(|x| x.as_str()), p.get("version").and_then(|x| x.as_str())) else { continue };
            let n = n.to_lowercase().replace('_', "-");
            // uv lists the project itself as a virtual/editable package.
            if p.get("source").and_then(|s| s.get("editable").or_else(|| s.get("virtual"))).is_some() {
                continue;
            }
            let direct = direct_names.contains(&n);
            let decl = declared.iter().find(|x| x.0 == n);
            acc.add(Package {
                name: n.clone(),
                ecosystem: eco.into(),
                declared: decl.map(|x| x.1.clone()),
                resolved: Some(v.into()),
                direct: Some(direct),
                group: decl.map(|x| x.2.clone()).unwrap_or_else(|| "prod".into()),
                manifest: manifest.clone(),
            });
            let deps: Vec<String> = match p.get("dependencies") {
                Some(toml::Value::Array(a)) => a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from)).collect(),
                Some(toml::Value::Table(t)) => t.keys().cloned().collect(),
                _ => vec![],
            };
            for dn in deps {
                let dn = dn.to_lowercase().replace('_', "-");
                if let Some(dv) = resolved.get(&dn) {
                    acc.edge(key(eco, &n, v), key(eco, &dn, dv));
                }
            }
        }
        break;
    }
    for (n, v, g) in &declared {
        if !resolved.contains_key(n) {
            // An exact pin is what pip installs.
            let pinned = v.strip_prefix("==").filter(|x| !x.contains(['*', ',', ' '])).map(String::from);
            acc.add(Package { name: n.clone(), ecosystem: eco.into(), declared: Some(v.clone()).filter(|x| !x.is_empty()), resolved: pinned, direct: Some(true), group: g.clone(), manifest: manifest.clone() });
        }
    }
    manifests.push(Manifest { path: manifest, ecosystem: eco.into(), lockfile });
}

// ------------------------------------------------------------ Go, JVM, .NET

fn scan_go(acc: &mut Acc, dir: &Path, d: &str, manifests: &mut Vec<Manifest>) {
    let Some(text) = read(&dir.join("go.mod")) else { return };
    let manifest = rel(d, "go.mod");
    let mut in_block = false;
    for line in text.lines() {
        let l = line.trim();
        let spec = if l.starts_with("require (") {
            in_block = true;
            continue;
        } else if in_block && l == ")" {
            in_block = false;
            continue;
        } else if in_block {
            l
        } else if let Some(r) = l.strip_prefix("require ") {
            r
        } else {
            continue;
        };
        let indirect = spec.contains("// indirect");
        let mut parts = spec.split_whitespace();
        if let (Some(n), Some(v)) = (parts.next(), parts.next()) {
            // go.mod records the selected (minimum) version exactly.
            acc.add(Package { name: n.into(), ecosystem: "Go".into(), declared: Some(v.into()), resolved: Some(v.into()), direct: Some(!indirect), group: "prod".into(), manifest: manifest.clone() });
        }
    }
    manifests.push(Manifest { path: manifest, ecosystem: "Go".into(), lockfile: dir.join("go.sum").is_file().then(|| rel(d, "go.sum")) });
}

fn xml_tag<'a>(block: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let s = block.find(&open)? + open.len();
    let e = block[s..].find(&close)? + s;
    Some(block[s..e].trim())
}

fn scan_jvm_dotnet(acc: &mut Acc, dir: &Path, d: &str, manifests: &mut Vec<Manifest>) {
    if let Some(text) = read(&dir.join("pom.xml")) {
        let manifest = rel(d, "pom.xml");
        for block in text.split("<dependency>").skip(1) {
            let block = block.split("</dependency>").next().unwrap_or("");
            if let (Some(g), Some(a)) = (xml_tag(block, "groupId"), xml_tag(block, "artifactId")) {
                let v = xml_tag(block, "version").map(String::from);
                let exact = v.clone().filter(|x| !x.contains(['$', '[', '(', ',']));
                let group = match xml_tag(block, "scope") {
                    Some("test") => "dev",
                    Some("provided") => "peer",
                    _ => "prod",
                };
                acc.add(Package { name: format!("{g}:{a}"), ecosystem: "Maven".into(), declared: v, resolved: exact, direct: Some(true), group: group.into(), manifest: manifest.clone() });
            }
        }
        manifests.push(Manifest { path: manifest, ecosystem: "Maven".into(), lockfile: None });
    }
    for g in ["build.gradle", "build.gradle.kts"] {
        let Some(text) = read(&dir.join(g)) else { continue };
        let manifest = rel(d, g);
        for line in text.lines() {
            let l = line.trim();
            let group = if l.starts_with("testImplementation") { "dev" } else if l.starts_with("implementation") || l.starts_with("api") || l.starts_with("runtimeOnly") || l.starts_with("compileOnly") { "prod" } else { continue };
            let Some(q) = l.find(['"', '\'']) else { continue };
            let rest = &l[q + 1..];
            let coord = rest.split(['"', '\'']).next().unwrap_or("");
            let parts: Vec<&str> = coord.split(':').collect();
            if parts.len() >= 3 {
                let v = parts[2].to_string();
                let exact = (!v.contains(['$', '+', '['])).then(|| v.clone());
                acc.add(Package { name: format!("{}:{}", parts[0], parts[1]), ecosystem: "Maven".into(), declared: Some(v), resolved: exact, direct: Some(true), group: group.into(), manifest: manifest.clone() });
            }
        }
        manifests.push(Manifest { path: manifest, ecosystem: "Maven".into(), lockfile: None });
        break;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.ends_with(".csproj") || name.ends_with(".fsproj")) {
            continue;
        }
        let Some(text) = read(&e.path()) else { continue };
        let manifest = rel(d, &name);
        let mut locked: HashMap<String, (String, bool)> = HashMap::new();
        if let Some(l) = read(&dir.join("packages.lock.json")).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            if let Some(fw) = l.get("dependencies").and_then(|x| x.as_object()) {
                for deps in fw.values() {
                    for (n, info) in deps.as_object().cloned().unwrap_or_default() {
                        let v = info.get("resolved").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let direct = info.get("type").and_then(|x| x.as_str()) == Some("Direct");
                        locked.insert(n.to_lowercase(), (v.clone(), direct));
                        if !direct {
                            acc.add(Package { name: n.clone(), ecosystem: "NuGet".into(), declared: None, resolved: Some(v), direct: Some(false), group: "prod".into(), manifest: manifest.clone() });
                        }
                    }
                }
            }
        }
        for part in text.split("<PackageReference").skip(1) {
            let tag = part.split('>').next().unwrap_or("");
            let attr = |a: &str| tag.split(&format!("{a}=\"")).nth(1).and_then(|r| r.split('"').next()).map(String::from);
            if let Some(n) = attr("Include") {
                let v = attr("Version").or_else(|| xml_tag(part, "Version").map(String::from));
                let resolved = locked.get(&n.to_lowercase()).map(|x| x.0.clone()).or_else(|| v.clone().filter(|x| !x.contains(['[', '(', '*', ','])));
                acc.add(Package { name: n, ecosystem: "NuGet".into(), declared: v, resolved, direct: Some(true), group: "prod".into(), manifest: manifest.clone() });
            }
        }
        manifests.push(Manifest { path: manifest, ecosystem: "NuGet".into(), lockfile: dir.join("packages.lock.json").is_file().then(|| rel(d, "packages.lock.json")) });
    }
}

pub fn scan(root: &Path) -> Report {
    let mut acc = Acc { packages: vec![], index: HashMap::new(), edges: vec![], truncated: false };
    let mut manifests = vec![];
    let mut dirs = vec![(root.to_path_buf(), String::new())];
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut subs: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.') && !crate::domain::git::SKIP_DIRS.contains(&n.as_str()))
            .collect();
        subs.sort();
        for n in subs.into_iter().take(40) {
            dirs.push((root.join(&n), n));
        }
    }
    for (dir, d) in &dirs {
        scan_npm(&mut acc, dir, d, &mut manifests);
        scan_cargo(&mut acc, dir, d, &mut manifests);
        scan_python(&mut acc, dir, d, &mut manifests);
        scan_go(&mut acc, dir, d, &mut manifests);
        scan_jvm_dotnet(&mut acc, dir, d, &mut manifests);
    }
    let mut packages = acc.packages;
    packages.sort_by(|a, b| b.direct.unwrap_or(false).cmp(&a.direct.unwrap_or(false)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let mut edges = acc.edges;
    edges.sort();
    edges.dedup();
    Report { root: root.to_string_lossy().to_string(), scanned_at: now_ms(), manifests, packages, edges, truncated: acc.truncated }
}

// ------------------------------------------------------------ advisories (OSV)

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Advisory {
    pub id: String,
    pub summary: Option<String>,
    pub aliases: Vec<String>,
    /// As provided by the advisory database (e.g. HIGH, or a CVSS vector).
    pub severity: Option<String>,
    pub affected: Option<String>,
    pub fixed: Option<String>,
    pub url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub name: String,
    pub ecosystem: String,
    pub version: String,
    pub advisories: Vec<Advisory>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvisoryReport {
    pub checked_at: i64,
    pub checked: usize,
    /// Packages without a resolved version, which couldn't be checked.
    pub unchecked: usize,
    pub findings: Vec<Finding>,
    pub source: String,
}

fn osv_agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).http_status_as_error(false).user_agent("Kern").build().into()
}

fn post_json(agent: &ureq::Agent, url: &str, body: &Value) -> AppResult<Value> {
    let mut r = agent.post(url).header("Content-Type", "application/json").send(body.to_string()).map_err(|e| AppError::Network(format!("Couldn't reach the advisory database ({e}).")))?;
    if r.status().as_u16() >= 400 {
        return Err(AppError::Network(format!("The advisory database returned {}.", r.status().as_u16())));
    }
    let text = r.body_mut().with_config().limit(32 * 1024 * 1024).read_to_string().unwrap_or_default();
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn severity_of(v: &Value) -> Option<String> {
    v.pointer("/database_specific/severity")
        .and_then(|s| s.as_str())
        .map(String::from)
        .or_else(|| v.get("severity").and_then(|s| s.as_array()).and_then(|a| a.first()).and_then(|s| s.get("score")).and_then(|s| s.as_str()).map(String::from))
}

fn advisory_from(v: &Value, name: &str) -> Advisory {
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut fixed = None;
    let mut affected = None;
    for a in v.get("affected").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        if a.pointer("/package/name").and_then(|n| n.as_str()).is_some_and(|n| !n.eq_ignore_ascii_case(name)) {
            continue;
        }
        for r in a.get("ranges").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
            let mut intro = None;
            for e in r.get("events").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                if let Some(i) = e.get("introduced").and_then(|x| x.as_str()) {
                    intro = Some(i.to_string());
                }
                if let Some(f) = e.get("fixed").and_then(|x| x.as_str()) {
                    fixed = Some(f.to_string());
                    affected = Some(format!(">= {}, < {f}", intro.clone().unwrap_or_else(|| "0".into())));
                }
            }
        }
    }
    Advisory {
        url: format!("https://osv.dev/vulnerability/{id}"),
        summary: v.get("summary").and_then(|x| x.as_str()).map(String::from).or_else(|| v.get("details").and_then(|x| x.as_str()).map(|d| d.chars().take(200).collect())),
        aliases: v.get("aliases").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default(),
        severity: severity_of(v),
        affected,
        fixed,
        id,
    }
}

pub fn check_advisories(packages: &[Package]) -> AppResult<AdvisoryReport> {
    let resolved: Vec<&Package> = {
        let mut seen = HashSet::new();
        packages.iter().filter(|p| p.resolved.is_some()).filter(|p| seen.insert((p.ecosystem.clone(), p.name.clone(), p.resolved.clone()))).collect()
    };
    let unchecked = packages.iter().filter(|p| p.resolved.is_none()).count();
    let agent = osv_agent();
    let mut hits: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (chunk_i, chunk) in resolved.chunks(500).enumerate() {
        let queries: Vec<Value> = chunk.iter().map(|p| json!({ "package": { "name": p.name, "ecosystem": p.ecosystem }, "version": p.resolved })).collect();
        let res = post_json(&agent, "https://api.osv.dev/v1/querybatch", &json!({ "queries": queries }))?;
        for (i, r) in res.get("results").and_then(|x| x.as_array()).cloned().unwrap_or_default().iter().enumerate() {
            let ids: Vec<String> = r.get("vulns").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|v| v.get("id").and_then(|s| s.as_str()).map(String::from)).collect()).unwrap_or_default();
            if !ids.is_empty() {
                hits.insert(chunk_i * 500 + i, ids);
            }
        }
    }
    let mut details: HashMap<String, Value> = HashMap::new();
    let mut findings = vec![];
    for (i, ids) in hits {
        let p = resolved[i];
        let mut advisories = vec![];
        for id in ids.iter().take(20) {
            if !details.contains_key(id) && details.len() < 150 {
                if let Ok(mut r) = agent.get(&format!("https://api.osv.dev/v1/vulns/{id}")).call() {
                    let t = r.body_mut().with_config().limit(4 * 1024 * 1024).read_to_string().unwrap_or_default();
                    details.insert(id.clone(), serde_json::from_str(&t).unwrap_or(Value::Null));
                }
            }
            let v = details.get(id).cloned().unwrap_or_else(|| json!({ "id": id }));
            advisories.push(advisory_from(&v, &p.name));
        }
        findings.push(Finding { name: p.name.clone(), ecosystem: p.ecosystem.clone(), version: p.resolved.clone().unwrap_or_default(), advisories });
    }
    Ok(AdvisoryReport { checked_at: now_ms(), checked: resolved.len(), unchecked, findings, source: "OSV (osv.dev)".into() })
}

// ------------------------------------------------------------ commands

fn cache_key(prefix: &str, root: &Path) -> String {
    format!("{prefix}:{}", folders::folder_key(root))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cached {
    pub report: Option<Report>,
    pub advisories: Option<AdvisoryReport>,
}

/// The last scan and advisory check for a target, without rescanning.
#[tauri::command]
pub async fn deps_cached(app: AppHandle, project_id: String, repository_id: Option<String>) -> AppResult<Cached> {
    blocking(&app, move |s| {
        s.with(|c| {
            let (root, _) = devenv::target_root(c, &project_id, repository_id.as_deref())?;
            let load = |k: String| -> AppResult<Option<String>> { Ok(c.query_row("SELECT data FROM dev_cache WHERE key = ?1", [k], |r| r.get(0)).optional()?) };
            Ok(Cached {
                report: load(cache_key("deps", &root))?.and_then(|t| serde_json::from_str(&t).ok()),
                advisories: load(cache_key("adv", &root))?.and_then(|t| serde_json::from_str(&t).ok()),
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn deps_scan(app: AppHandle, project_id: String, repository_id: Option<String>) -> AppResult<Report> {
    blocking(&app, move |s| {
        let (root, _) = s.with(|c| devenv::target_root(c, &project_id, repository_id.as_deref()))?;
        let report = scan(&root);
        let data = serde_json::to_string(&report)?;
        s.with(|c| {
            c.execute(
                "INSERT INTO dev_cache(key, data, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
                params![cache_key("deps", &root), data, now_ms()],
            )?;
            Ok(())
        })?;
        Ok(report)
    })
    .await
}

/// Looks up known advisories for the last scan's resolved versions (OSV).
/// Sends package names and versions only, nothing else from the project.
#[tauri::command]
pub async fn deps_advisories(app: AppHandle, project_id: String, repository_id: Option<String>) -> AppResult<AdvisoryReport> {
    blocking(&app, move |s| {
        let (root, network, cached) = s.with(|c| {
            let (root, _) = devenv::target_root(c, &project_id, repository_id.as_deref())?;
            let cached: Option<String> = c.query_row("SELECT data FROM dev_cache WHERE key = ?1", [cache_key("deps", &root)], |r| r.get(0)).optional()?;
            Ok((root, settings::get_or(c, "privacy.network", true), cached))
        })?;
        if !network {
            return invalid("External network requests are turned off in Privacy settings.");
        }
        let report: Report = match cached.and_then(|t| serde_json::from_str(&t).ok()) {
            Some(r) => r,
            None => scan(&root),
        };
        let adv = check_advisories(&report.packages)?;
        let data = serde_json::to_string(&adv)?;
        s.with(|c| {
            c.execute(
                "INSERT INTO dev_cache(key, data, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
                params![cache_key("adv", &root), data, now_ms()],
            )?;
            Ok(())
        })?;
        Ok(adv)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_lock_resolves_versions_and_edges() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"name":"app","version":"1.0.0","dependencies":{"react":"^18.2.0","left-pad":"^1.0.0"},"devDependencies":{"vite":"^5"}}"#).unwrap();
        std::fs::write(
            dir.path().join("package-lock.json"),
            r#"{"lockfileVersion":3,"packages":{"":{"name":"app"},"node_modules/react":{"version":"18.2.0","dependencies":{"loose-envify":"^1.1.0"}},"node_modules/loose-envify":{"version":"1.4.0"},"node_modules/vite":{"version":"5.1.0","dev":true}}}"#,
        )
        .unwrap();
        let r = scan(dir.path());
        let react = r.packages.iter().find(|p| p.name == "react").unwrap();
        assert_eq!((react.declared.as_deref(), react.resolved.as_deref(), react.direct), (Some("^18.2.0"), Some("18.2.0"), Some(true)));
        let le = r.packages.iter().find(|p| p.name == "loose-envify").unwrap();
        assert_eq!(le.direct, Some(false));
        let vite = r.packages.iter().find(|p| p.name == "vite").unwrap();
        assert_eq!(vite.group, "dev");
        // Not in the lockfile: declared only, never shown as resolved.
        let lp = r.packages.iter().find(|p| p.name == "left-pad").unwrap();
        assert!(lp.resolved.is_none() && lp.declared.as_deref() == Some("^1.0.0"));
        assert!(r.edges.contains(&("npm:react@18.2.0".into(), "npm:loose-envify@1.4.0".into())));
    }

    #[test]
    fn cargo_lock_marks_direct_and_transitive() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname = \"app\"\nversion = \"0.1.0\"\n[dependencies]\nserde = \"1\"\n[dev-dependencies]\ntempfile = \"3\"\n").unwrap();
        std::fs::write(
            dir.path().join("Cargo.lock"),
            "version = 3\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\ndependencies = [\"serde\", \"tempfile\"]\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.200\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\ndependencies = [\"serde_derive\"]\n\n[[package]]\nname = \"serde_derive\"\nversion = \"1.0.200\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"tempfile\"\nversion = \"3.10.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n",
        )
        .unwrap();
        let r = scan(dir.path());
        let serde = r.packages.iter().find(|p| p.name == "serde").unwrap();
        assert_eq!((serde.resolved.as_deref(), serde.direct, serde.declared.as_deref()), (Some("1.0.200"), Some(true), Some("1")));
        assert_eq!(r.packages.iter().find(|p| p.name == "serde_derive").unwrap().direct, Some(false));
        assert_eq!(r.packages.iter().find(|p| p.name == "tempfile").unwrap().group, "dev");
        assert!(!r.packages.iter().any(|p| p.name == "app"), "the project itself isn't a dependency");
    }

    #[test]
    fn python_go_and_pnpm() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("requirements.txt"), "requests>=2.31\nflask==3.0.0  # web\n-r other.txt\n").unwrap();
        std::fs::write(dir.path().join("go.mod"), "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgolang.org/x/net v0.20.0 // indirect\n)\n").unwrap();
        std::fs::create_dir(dir.path().join("web")).unwrap();
        std::fs::write(dir.path().join("web/package.json"), r#"{"dependencies":{"react":"^18"}}"#).unwrap();
        std::fs::write(
            dir.path().join("web/pnpm-lock.yaml"),
            "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      react:\n        specifier: ^18\n        version: 18.3.1\n\npackages:\n\n  js-tokens@4.0.0:\n    resolution: {integrity: x}\n\n  react@18.3.1:\n    resolution: {integrity: y}\n\nsnapshots:\n\n  js-tokens@4.0.0: {}\n\n  react@18.3.1:\n    dependencies:\n      js-tokens: 4.0.0\n",
        )
        .unwrap();
        let r = scan(dir.path());
        let req = r.packages.iter().find(|p| p.name == "requests").unwrap();
        assert!(req.resolved.is_none(), "a range isn't a resolved version");
        assert_eq!(r.packages.iter().find(|p| p.name == "flask").unwrap().resolved.as_deref(), Some("3.0.0"));
        assert_eq!(r.packages.iter().find(|p| p.name == "golang.org/x/net").unwrap().direct, Some(false));
        let react = r.packages.iter().find(|p| p.name == "react").unwrap();
        assert_eq!((react.resolved.as_deref(), react.direct), (Some("18.3.1"), Some(true)));
        assert!(r.edges.contains(&("npm:react@18.3.1".into(), "npm:js-tokens@4.0.0".into())));
    }

    #[test]
    fn reads_advisory_fixed_versions() {
        let v = json!({"id":"GHSA-x","summary":"Bad","database_specific":{"severity":"HIGH"},"affected":[{"package":{"name":"lodash","ecosystem":"npm"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"},{"fixed":"4.17.21"}]}]}]});
        let a = advisory_from(&v, "lodash");
        assert_eq!((a.severity.as_deref(), a.fixed.as_deref()), (Some("HIGH"), Some("4.17.21")));
        assert_eq!(a.url, "https://osv.dev/vulnerability/GHSA-x");
    }
}
