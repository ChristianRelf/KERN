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
                         daily-briefing, focus, search, capture, settings, trash, onboarding
  lib/                   typed IPC client, query layer, dates, shortcuts, fuzzy matching
  stores/                Zustand stores for transient UI state, settings, router, undo, toasts
  styles/                design tokens (CSS variables), base, controls, layout
src-tauri/src/
  db/                    connection setup, versioned migrations
  domain/                one module per area: pure service functions on &Connection plus
                         thin #[tauri::command] wrappers
  scheduler.rs           single low-frequency thread: briefings, reminders, backups, housekeeping
  window.rs              window state persistence, tray, close/minimise behaviour
```

- The frontend never issues SQL. It calls typed commands (`src/lib/ipc.ts`). Errors come
  back as `{ code, message }` and are shown as actionable messages with Retry.
- Persisted data uses TanStack Query (keys are grouped by domain for invalidation).
  Mutations are optimistic, roll back on failure, and offer Undo where reversible.
- Heavy modules (whiteboard renderer, rich-text editor, settings, calendar) are
  lazy-loaded chunks.

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

- No network access is needed. The only optional network use is fetching a link's
  title or favicon when you add a link (Settings → Data & Backups → Privacy).
- Tauri capabilities are limited to window show/focus, native open/save dialogs,
  notifications, autostart and the optional global quick-capture shortcut. Opening
  files and URLs, and all file writes, go through Kern's own commands.
- The asset protocol can only read the app's `attachments` folder.

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

See `PERFORMANCE.md` for measurements.
