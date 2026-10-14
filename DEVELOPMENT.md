# Developing Kern

Notes for building Kern from source and working on the code. If you just want
to use the app, see the [README](README.md).

Kern is a [Tauri 2](https://v2.tauri.app) app: a React + TypeScript frontend and
a Rust backend that owns all data (SQLite) and OS integration.

## Running and building

Requirements: Node 20+, Rust (stable, MSVC toolchain on Windows), WebView2
(preinstalled on Windows 11). On Linux, install the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/#linux)
(WebKitGTK 4.1, libayatana-appindicator, librsvg, patchelf).

```bash
npm install
npm run app:dev      # development (Vite + Tauri, hot reload)
npm run app:build    # release installers in src-tauri/target/release/bundle/
npm test             # frontend unit tests (Vitest)
cd src-tauri && cargo test   # backend unit and integration tests
```

Linux release bundles (.deb, .rpm, AppImage) are built in an Ubuntu 22.04
container so they run on older distributions too; from any OS with Docker:

```bash
docker build -t kern-linux scripts/linux
docker run --rm -v "$PWD:/repo:ro" -v "$PWD/release/linux:/out" \
  -v kern-cargo:/root/.cargo/registry -v kern-target:/build/src-tauri/target kern-linux
```

To run a development or test instance against a separate data folder (so your
real data is never touched), set `KERN_DATA_DIR` before launching. Such an
instance runs alongside the normal one and uses its own credential-store namespace.

## Releasing and in-app updates

Kern updates itself: when a newer release exists, the sidebar's *Update
available* button (or *Update to …* in Settings → About) swaps the window for a
minimal update screen, downloads the signed installer (up to three attempts;
if all fail it returns to the running version), and installs it. Copies
installed with the `.exe` update silently, with Kern's update screen as the only
UI; `.msi` copies are per-machine, so their installer runs passively and Windows
asks for admin approval (see `context()` in `src-tauri/src/lib.rs`). On the
first start of the new version a *What's new* dialog shows that release's
notes, read from its GitHub release (or from `latest.json` when offline). The
code is in `src/features/updates/`.

The updater reads `latest.json` from the newest (non-pre-release) GitHub
release and only installs files signed with the updater key. The public key is
in `tauri.conf.json` (`plugins.updater.pubkey`); the private key lives outside
the repository, at `~/.tauri/kern-updater.key` by default. **Back it up:** if
it's lost, installed copies can't verify any future update and everyone has to
reinstall by hand once.

To release a new version:

1. Bump the version in `package.json`, `package-lock.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`;
   commit, tag `v<version>` and push both.
2. Write the release notes (Markdown; a `## What's new` section and an
   optional `## Install` section, which the in-app dialog leaves out).
3. `npm run release -- --notes notes.md --publish`

The script builds the installers with updater signatures, writes
`src-tauri/target/release/bundle/latest.json`, and creates the GitHub release
with the `.exe`, `.msi` and `latest.json` attached. Without `--publish` it
stops after building. The key can also come from `TAURI_SIGNING_PRIVATE_KEY`
(its contents) or `KERN_UPDATER_KEY` (a path).

### Security releases

Add `--security` to make a release a required update. The script puts
`<!-- kern:security -->` at the top of its notes (invisible on GitHub); any
copy older than a release carrying that marker updates without asking, even
when newer, ordinary releases have come out since. Kern starts the update screen
by itself in every mode. If it doesn't finish, Kern stays usable (it's
local-first, so nobody is locked out of their data while offline), shows a
*Security update required* notice, and tries again every 10 minutes and on
each start. Copies with network access turned off in Settings → Privacy don't
check, so they aren't forced either. Use it only for real security fixes.

## Renaming the app

The name "Kern" is provisional. To change it:

1. `src/app/brand.ts`: `APP_NAME` (all UI text).
2. `src-tauri/tauri.conf.json`: `productName` and the window `title`. Changing
   `identifier` moves the data folder (see below).
3. Optionally, `package.json` / `src-tauri/Cargo.toml` package names and the
   icon (`assets/icon.svg`, then `npx tauri icon assets/icon.svg`).

## Architecture

```
src/                     React + TypeScript (strict), Vite
  app/                   bootstrap, routes, global effects and shortcuts
  components/ui|layout   design-system controls (Radix primitives, custom styling) and the shell
  features/<feature>/    dashboard, tasks, boards, projects, whiteboard, notes, inbox,
                         daily-briefing, focus, search, capture, settings, trash, onboarding,
                         storage, links, ai (API accounts), github (GitHub & git),
                         command-centre (project overview), milestones, sessions, workspace
                         (resume & snapshots), catchup, health, terminal, dev (repositories,
                         worktrees, commands, environment profiles, services, dependencies)
  lib/                   typed IPC client, query layer, dates, shortcuts, fuzzy matching
  stores/                Zustand stores for transient UI state, settings, router, undo, toasts
  styles/                design tokens (CSS variables), base, controls, layout
src-tauri/src/
  db/                    connection setup, versioned migrations
  domain/                one module per area: pure service functions on &Connection plus
                         thin #[tauri::command] wrappers (incl. folders, storage, links,
                         ai/{vault,provider,router,accounts}, git, github, repos, worktrees,
                         workflow, sessions, workspace, milestones, devenv, pty, envvars,
                         services, deps, health, catchup, fileindex)
  scheduler.rs           single low-frequency thread: briefings, reminders, backups, housekeeping
  window.rs              window state persistence, tray, close/minimise behaviour
```

- The frontend never issues SQL. It calls typed commands (`src/lib/ipc.ts`). Errors come
  back as `{ code, message }` and are shown as actionable messages with Retry.
- Persisted data uses TanStack Query (keys are grouped by domain for invalidation).
  Mutations are optimistic, roll back on failure, and offer Undo where reversible.
- Heavy modules (whiteboard renderer, rich-text editor, settings, calendar, storage
  chart, API pages, Code tab) are lazy-loaded chunks.
- Network and filesystem work (storage scans, favicon/link fetching, AI requests,
  git, GitHub) runs in async commands on background threads, never the UI thread.

## Data

- Database: SQLite (WAL, foreign keys, FTS5 search kept in sync by triggers) at
  `%APPDATA%\app.kern.desktop\kern.db` (Linux: `~/.local/share/app.kern.desktop/kern.db`).
  Managed attachments live alongside it in `attachments/` and are referenced by relative paths, so backups restore on other machines.
- Dates are local calendar dates (`YYYY-MM-DD`) and times are `HH:MM`, so due dates
  never shift with timezone or DST changes. Instants are UTC epoch milliseconds.
- Migrations are versioned with `PRAGMA user_version`. Each runs in its own
  transaction (an interrupted migration rolls back), and a full copy of the
  database is written to `backups\` before an existing database is migrated.
- Deleting moves items to a recoverable Trash (purged after a configurable period).

### Backups and export

One versioned zip format (`manifest.json` + `kern.db` + `attachments/`) is used for
automatic, manual and pre-restore backups. "Export everything" adds portable copies:
`data/<table>.json`, `notes/*.md` (with front matter), `whiteboards/*.json` and
`settings.json`. Restore validates the archive (manifest, integrity check, schema
version), shows a preview, writes a safety backup, copies the data in with SQLite's
online backup API and swaps attachments atomically. Separate exports produce tasks
as CSV, notes as Markdown and projects as JSON.

## Kern Cloud (optional sync and collaboration)

The server lives in the separate `KERNWEB` repository (Node, Hono, Better Auth,
PostgreSQL) at `https://api.relf.cloud/kern/v1`. Development builds can point
elsewhere with `KERN_CLOUD_URL` (e.g. `http://localhost:8787/kern/v1`).

- **Offline mode** is the ordinary `kern.db`, unchanged and account-free.
- **Spaces**: the personal space and each workspace get a local replica at
  `cloud/<user>/<space>.db` with the same schema, so every feature works the
  same (and offline). Switching spaces swaps the connection in `AppState`.
  Per-computer tables (settings, AI accounts and usage, folder trust, caches,
  notification log, linked-file index; `db::DEVICE_TABLES`) are parked under a
  `_device_` prefix in replicas, and `kern.db` is attached as `local`, so
  unqualified names resolve to the device copy. Migrations unpark, migrate and
  re-park, so every schema step applies to replicas unchanged.
- **Sync** (`domain/cloud/sync.rs`): triggers on the synced tables
  (`sync::TABLES`) record changed rows in `sync_outbox`. A push sends field-level
  diffs against `sync_shadow` (the server's version as last known), or the full
  row for new records; personal columns (pins, last opened, whiteboard viewport,
  local repository links) never sync. The server merges per field and replies
  with merged rows, which are applied like any remote change: a three-way merge
  where fields with unsent local edits keep the local value. Deletes win and
  leave tombstone shadows, so stale copies can't resurrect a record. Remote
  rows are applied with change capture paused and foreign keys off.
- **Worker** (`domain/cloud/mod.rs`): one background thread, woken by the
  replica's commit hook, pushes and pulls with backoff, and emits
  `kern://cloud-sync` (status) and `kern://cloud-applied` (tables and
  whiteboards changed; the interface invalidates matching queries).
- **Session**: the Better Auth bearer token is stored in the OS credential
  store and used only by the backend (`cloud_request` proxies API calls). The
  interface opens the realtime socket with a single-use ticket, hands incoming
  changes to `cloud_apply`, and shares presence (view, whiteboard cursor and
  selection) and live drags.
- **Whiteboards** save diffs (`whiteboard_patch`) against a per-editor baseline
  and three-way merge collaborators' saves (`features/whiteboard/collab.ts`);
  undo only reverts your own edits. Images placed on a cloud whiteboard are
  compressed in the interface (WebP, ≤1600 px, stepped down to ~400 KB;
  `features/whiteboard/cloudImages.ts`), uploaded once per space (de-duplicated
  by hash) and referenced as `data.cloudAsset`. Other computers show the original
  when they have it, otherwise download the shared copy into
  `cache/cloud-assets/<space>/` (`cloud_image_path`).
- **Invitations**: `link.relf.cloud/kern/invite/<id>` hands off to
  `kern://invite/<id>` (tauri-plugin-deep-link; single-instance forwards it).
- Backups, restore and "export everything" cover offline data only; automatic
  orphaned-asset cleanup is skipped once cloud replicas exist (their whiteboards
  may use attachment files).

Tests: `cargo test cloud` (engine and client), `npx vitest run collab`, and an
opt-in two-replica test against a running server (see KERNWEB's README).

## Privacy and permissions

- No network access is needed. Every network use is optional and controlled in
  Settings → Privacy, with a master switch that turns all of it off:
  - website favicons and link titles, fetched directly from the linked site (never
    a third-party proxy), cached locally; private/local addresses are refused;
  - AI requests and connection tests, only when you make them (no polling);
  - GitHub issue sync and pull requests, only for projects you connect;
  - Kern Cloud, only after turning on online collaboration and signing in.
- AI API keys and the GitHub token live in the OS credential store (Windows
  Credential Manager / macOS Keychain / Secret Service), never in SQLite, logs or
  backups. Only the backend uses them. GitHub can also use the GitHub CLI's login.
- Linked project folders are separate from projects: deleting a project never
  touches its folder. Folders are restricted by default; programs, git commands
  and file changes need an explicit "trusted" decision, recorded per exact folder.
- Tauri capabilities are limited to window show/focus, native open/save dialogs,
  notifications, autostart and the optional global quick-capture shortcut. The CSP
  allows one remote connection: the Kern Cloud realtime socket. Opening
  files and URLs, and all file writes, go through Kern's own commands.
- The asset protocol can only read the app's `attachments` folder and the favicon
  cache, and the CSP no longer allows remote images.

## Key behaviours

- **Daily rundown**: a deterministic, offline summary with a transparent score
  (priority, days overdue, due today, pinned, in progress, carried over, project
  deadline, minus blocked). Each suggestion shows its score breakdown, can be
  dismissed for the day, or pinned. The first rundown of each day is stored as a
  snapshot for history; the evening review stores what was done and what moved.
- **Recurring tasks**: completing an occurrence keeps it as history and spawns the
  next one (with its checklist reset). Missed occurrences are skipped, not
  back-filled. "From completion" schedules relative to the completion day.
- **Focus timer**: timestamp-based, so it stays accurate when minimised. The
  completion notification is fired from a native thread.

- **Task completion**: a left-to-right strikethrough (CSS only, no layout
  measurement); writes are ordered and coalesced per task so rapid clicks always
  converge on the last click. Instant with reduced motion.
- **AI routing**: Manual, Automatic failover, Priority or Cost-conscious. Failover
  only replays requests that produced no output, honours retry-after, never rotates
  between keys in the same organisation after a pool-wide limit, and is bounded.
- **GitHub issues**: two-way, three-way-merged per field (newer edit wins when
  both sides changed). Deleting a task unlinks it; it never closes the issue.

### Kern Lite

The same window can run as full Kern or as **Kern Lite**, a small task tracker
(`src/features/lite/`, its own lazily loaded chunk; full Kern lives in
`src/app/Shell.tsx`). Both use the same backend and data, so there's nothing to
sync between them. `window.rs` tracks the mode, gives each mode its own minimum
size and remembered geometry (`internal.windowState` / `internal.liteWindowState`),
and handles `--lite` / `--full` on the command line (also forwarded by the
single-instance plugin, and used by the Windows installer's "Kern Lite" Start menu
shortcut from `src-tauri/windows/hooks.nsh`). `general.startMode` (ask, kern, lite)
picks the mode at launch; "ask" shows `src/app/StartChooser.tsx`.

Switching cloud space or account calls `resetInterface` (`src/app/reset.ts`):
the query cache is cleared and the shell remounts, so nothing from the previous
data stays on screen.

### Projects, with optional development tools

A project needs only a name. Everything else - folders, repositories, commands,
services - is optional and only appears once it's connected, so a renovation or a
school assignment never shows git tabs or empty developer panels.

- **Command Centre**: each project's overview is an editable widget grid (the
  dashboard engine) starting from a preset that fits the project - General, or
  Hybrid once code is linked. Development widgets load lazily and only if added.
- **Resume Workspace**: Kern remembers each project's tab, board, whiteboard, open
  task, open file, selected repository and terminal layout (debounced, flushed on
  navigation/close) and restores it, skipping anything that no longer exists.
  Named workspace snapshots can be saved and reapplied. Resuming never runs
  commands, restarts services or starts assistants.
- **Milestones** work in every project (target date, status, progress from tasks or
  manual, dependencies) and can optionally be releases (version, repository, linked
  pull requests and issues, changelog draft). Tasks join a milestone through
  `tasks.milestone_id` - still one task record. Publishing a release is always done
  by the user on GitHub; Kern only opens a prefilled draft.
- **Work sessions** are timestamp-based (elapsed = end − start − paused), so sleep,
  minimising and restarts never drift. A long silence before a heartbeat is offered
  as a gap to keep or exclude. Only explicit links are stored; inferred pull
  requests are labelled. No keystrokes, screenshots or other apps are tracked.
- **Repositories**: a project can link zero, one or many (local clone, GitHub, or
  both). The existing folder link and GitHub issue sync are adopted automatically.
  Unlinking never touches disk or GitHub. Git commands are repository-scoped and
  still need a trusted folder.
- **Worktrees** are always read from `git worktree list` (including ones Kern didn't
  create). Removal shows the real status first; a dirty worktree needs explicit
  confirmation, a locked one is never removed, and branches are only deleted with
  `git branch -d`. Kern never runs clean, reset, force-push or history rewrites.
- **Start Work** on a task begins a session; with a trusted repository it can also
  create (or reuse) a branch or worktree with a suggested, git-validated name and
  link it to the task. Completing a task never commits, pushes, merges or deletes.
- **Environment detection** reads configuration files only (package.json,
  Cargo.toml, pyproject.toml, go.mod, …) and checks PATH; nothing is executed.
  **Saved commands** are a program plus an argument list (no shell string), run only
  when clicked, in a terminal tab, in a trusted folder.
- **Terminal**: real pseudoterminals (ConPTY on Windows) rendered with xterm.js,
  loaded on first use. Processes run with the user's permissions (trust is not a
  sandbox), are stopped as a tree on close, and quitting with running commands asks
  first. Output is never persisted.
- **Environment profiles**: plain values in SQLite, secrets in the OS credential
  store (only a reference in SQLite, never logged or backed up), injected into the
  launched process only. `.env` import defaults likely credentials to secrets;
  exporting secrets needs explicit consent.
- **Local services** are only the endpoints the user adds, checked only while the
  project is open. "Running" means it answered; "healthy" only when a configured
  HTTP check passed. Docker is optional.
- **Dependencies** come from manifests and lockfiles; a declared range is never shown
  as a resolved version. OSV advisory lookups are explicit and send only package
  names and resolved versions; a clean result reads "no known advisories".
- **Health** is a state (On track / Needs attention / Blocked / No recent data) with
  clickable reasons and configurable rules - no scores. Development signals only
  count when the project has them, and come from data already fetched.
- **Catch-up** builds a deterministic local digest with numbered sources (works with
  no AI). The optional AI summary shows what's included and its size first, honours
  the global and per-project content permissions, redacts key-like strings, and
  drops any claim that doesn't cite a known source.
- **Universal search** (Ctrl+K) adds milestones, saved commands, workspaces, synced
  issues, cached pull requests and commits, and linked-folder files and code from an
  incremental index (skipping dependencies, build output, `.gitignore`d, binary and
  secret-looking files), with filters.

See `PERFORMANCE.md` for measurements.
