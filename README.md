# Kern

A local-first personal productivity workspace for Windows (portable to macOS and
Linux): dashboard, tasks, projects, Kanban boards, whiteboards, notes, a daily
rundown and a focus timer, in one calm desktop app. Everything stays on your
computer; there is no account, server or telemetry.

## Running

Requirements: Node 20+, Rust (stable, MSVC toolchain on Windows), WebView2
(preinstalled on Windows 11).

```bash
npm install
npm run app:dev      # development (Vite + Tauri, hot reload)
npm run app:build    # release installers in src-tauri/target/release/bundle/
npm test             # frontend unit tests (Vitest)
cd src-tauri && cargo test   # backend unit and integration tests
```

To run a development or test instance against a separate data folder (so your
real data is never touched), set `KERN_DATA_DIR` before launching. Such an
instance runs alongside the normal one and uses its own credential-store namespace.

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
                         storage, links, ai (API accounts), github (GitHub & git)
  lib/                   typed IPC client, query layer, dates, shortcuts, fuzzy matching
  stores/                Zustand stores for transient UI state, settings, router, undo, toasts
  styles/                design tokens (CSS variables), base, controls, layout
src-tauri/src/
  db/                    connection setup, versioned migrations
  domain/                one module per area: pure service functions on &Connection plus
                         thin #[tauri::command] wrappers (incl. folders, storage, links,
                         ai/{vault,provider,router,accounts}, git, github)
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
  `%APPDATA%\app.kern.desktop\kern.db`. Managed attachments live alongside it in
  `attachments\` and are referenced by relative paths, so backups restore on other machines.
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

## Privacy and permissions

- No network access is needed. Every network use is optional and controlled in
  Settings → Privacy, with a master switch that turns all of it off:
  - website favicons and link titles, fetched directly from the linked site (never
    a third-party proxy), cached locally; private/local addresses are refused;
  - AI requests and connection tests, only when you make them (no polling);
  - GitHub issue sync and pull requests, only for projects you connect.
- AI API keys and the GitHub token live in the OS credential store (Windows
  Credential Manager / macOS Keychain / Secret Service), never in SQLite, logs or
  backups. Only the backend uses them. GitHub can also use the GitHub CLI's login.
- Linked project folders are separate from projects: deleting a project never
  touches its folder. Folders are restricted by default; programs, git commands
  and file changes need an explicit "trusted" decision, recorded per exact folder.
- Tauri capabilities are limited to window show/focus, native open/save dialogs,
  notifications, autostart and the optional global quick-capture shortcut. Opening
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

See `PERFORMANCE.md` for measurements.
