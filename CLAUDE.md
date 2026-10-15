# Kern

Tauri 2 desktop app: React 19 + TypeScript front end (`src/`), Rust back end
(`src-tauri/`), SQLite for storage.

## File headers

Every source file starts with an author/date header. New files get one at
creation; the date is the date the file was created and never changes
afterwards.

`.ts`, `.tsx`, `.css`, `.mjs`:

```
/**
 * @Author Christian Relf
 * @Date YYYY-MM-DD
 */
```

`.rs`:

```
// @Author Christian Relf
// @Date YYYY-MM-DD
```

The header goes first in the file (after a shebang, if any), followed by a
blank line, then any existing module comment — in Rust it sits above the
`//!` module docs. Files that cannot carry comments (JSON, lock files) are
exempt, as are Markdown docs and generated output.

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Tests | `npm test` |
| Web build | `npm run build` |
| Rust check | `cd src-tauri && cargo check` |
| Run the app | `npm run app:dev` |
