/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// Builds signed Windows installers and the updater manifest (latest.json),
// and optionally publishes them as the GitHub release for the current
// version.
//
//   node scripts/release.mjs --notes notes.md            build + manifest
//   node scripts/release.mjs --notes notes.md --publish  ...then publish
//   add --security for a security release: installs update to it without
//   asking (it marks the notes with <!-- kern:security -->)
//
// The updater signing key is read from TAURI_SIGNING_PRIVATE_KEY, or the file
// at KERN_UPDATER_KEY, or ~/.tauri/kern-updater.key. Keep that file backed
// up: installs only accept updates signed with it (the public half is in
// tauri.conf.json under plugins.updater.pubkey).
//
// Publishing needs the tag v<version> pushed to origin first, so the release
// can't be created against the wrong commit.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = "ChristianRelf/KERN";
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// Windows runs commands through the shell (for npx), so paths and spaced
// values need quoting there.
const q = (s) => (process.platform === "win32" ? `"${s}"` : s);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
  return r;
}

function output(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ------------------------------------------------------------ version

const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pkg.version !== version || cargo !== version) fail(`Versions disagree: tauri.conf.json ${version}, package.json ${pkg.version}, Cargo.toml ${cargo}.`);
if (!conf.plugins?.updater?.pubkey) fail("tauri.conf.json has no plugins.updater.pubkey.");

const notesPath = option("--notes");
if (!notesPath) fail("Pass the release notes: --notes <file.md>");
if (!existsSync(notesPath)) fail(`No notes at ${notesPath}`);
const MARKER = "<!-- kern:security -->";
let notes = readFileSync(notesPath, "utf8").trim();
if (flag("--security") && !notes.toLowerCase().includes(MARKER)) notes = `${MARKER}\n${notes}`;
if (notes.toLowerCase().includes(MARKER)) console.log("\n! Security release: installs will update to it without asking.");

// ------------------------------------------------------------ signing key

let key = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!key) {
  const keyPath = process.env.KERN_UPDATER_KEY || join(homedir(), ".tauri", "kern-updater.key");
  if (!existsSync(keyPath)) fail(`No updater signing key: set TAURI_SIGNING_PRIVATE_KEY or KERN_UPDATER_KEY, or put it at ${keyPath}.`);
  key = readFileSync(keyPath, "utf8").trim();
}

// ------------------------------------------------------------ build

console.log(`\n▸ Building Kern ${version} with updater artifacts…\n`);
// Updater artifacts are only made for releases, so everyday builds don't
// need the key.
const work = mkdtempSync(join(tmpdir(), "kern-release-"));
const overrides = join(work, "release.conf.json");
writeFileSync(overrides, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
// The notes as published (with the security marker, when there is one).
const publishedNotes = join(work, "notes.md");
writeFileSync(publishedNotes, notes + "\n");
run("npx", ["tauri", "build", "--config", q(overrides)], {
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
});

// ------------------------------------------------------------ manifest

const bundle = join(root, "src-tauri/target/release/bundle");
const artifacts = {
  nsis: join(bundle, "nsis", `Kern_${version}_x64-setup.exe`),
  msi: join(bundle, "msi", `Kern_${version}_x64_en-US.msi`),
};
const platform = (file) => {
  if (!existsSync(file) || !existsSync(`${file}.sig`)) fail(`Missing ${file} or its .sig - was the build signed?`);
  const name = file.split(/[\\/]/).pop();
  return { signature: readFileSync(`${file}.sig`, "utf8").trim(), url: `https://github.com/${REPO}/releases/download/v${version}/${name}` };
};
// The oldest version without known security issues. Installs older than it
// must update (see check_for_update). It's carried forward from the release
// being replaced, so skipping a security release doesn't make it optional;
// a security release raises it to itself.
const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split("-")[0].split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
};
const res = await fetch(`https://github.com/${REPO}/releases/latest/download/latest.json`);
if (!res.ok && res.status !== 404) fail(`Couldn't read the published latest.json (${res.status}), so the minimum secure version can't be carried forward.`);
const previous = res.ok ? await res.json() : null;
let minSecure = previous?.kern?.minSecureVersion ?? null;
if (previous?.notes?.toLowerCase().includes(MARKER) && (!minSecure || cmp(previous.version, minSecure) > 0)) minSecure = previous.version;
if (notes.toLowerCase().includes(MARKER)) minSecure = version;
if (minSecure) console.log(`\nMinimum secure version: ${minSecure}${minSecure === version ? " (this release)" : " (carried forward)"}`);

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  ...(minSecure ? { kern: { minSecureVersion: minSecure } } : {}),
  platforms: {
    // The updater picks "<os>-<arch>-<installer>" first, matching how Kern
    // was installed, then falls back to "<os>-<arch>".
    "windows-x86_64": platform(artifacts.nsis),
    "windows-x86_64-nsis": platform(artifacts.nsis),
    "windows-x86_64-msi": platform(artifacts.msi),
  },
};
const manifestPath = join(bundle, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n✓ Signed installers and ${manifestPath}`);

// ------------------------------------------------------------ publish

if (!flag("--publish")) {
  console.log(`\nNot published. To publish: push tag v${version}, then re-run with --publish.`);
  process.exit(0);
}
const tag = `v${version}`;
if (!output("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) fail(`Tag ${tag} isn't on origin yet - push it first.`);
console.log(`\n▸ Publishing ${tag}…\n`);
run("gh", [
  "release", "create", tag,
  "--repo", REPO,
  "--title", q(`Kern ${version}`),
  "--notes-file", q(publishedNotes),
  ...[artifacts.nsis, artifacts.msi, manifestPath].map(q),
]);
console.log(`\n✓ Released https://github.com/${REPO}/releases/tag/${tag}`);
