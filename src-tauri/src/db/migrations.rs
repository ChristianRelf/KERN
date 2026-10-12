//! Versioned schema migrations. `PRAGMA user_version` tracks the applied
//! version. Each migration runs inside its own transaction, so an
//! interrupted migration rolls back cleanly; additionally a full database
//! copy is taken before migrating an existing database (see `db::open`).

pub const MIGRATIONS: &[&str] = &[MIGRATION_1, MIGRATION_2, MIGRATION_3];

const MIGRATION_1: &str = r#"
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE project_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  accent TEXT,
  target_date TEXT,
  group_id TEXT REFERENCES project_groups(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  default_view TEXT,
  hidden_tabs TEXT NOT NULL DEFAULT '[]',
  default_board_id TEXT,
  last_opened_at INTEGER,
  archived_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_group ON projects(group_id);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_boards_project ON boards(project_id);

CREATE TABLE board_columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  status TEXT,
  wip_limit INTEGER,
  collapsed INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_columns_board ON board_columns(board_id, sort_order);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 0,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  column_id TEXT REFERENCES board_columns(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  due_date TEXT,
  due_time TEXT,
  start_date TEXT,
  estimate_minutes INTEGER,
  tracked_seconds INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  board_order REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT,
  series_id TEXT,
  reminder_minutes INTEGER,
  completed_at INTEGER,
  archived_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id, deleted_at);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_status ON tasks(status, deleted_at);
CREATE INDEX idx_tasks_due ON tasks(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_tasks_column ON tasks(column_id, board_order);
CREATE INDEX idx_tasks_completed ON tasks(completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX idx_tasks_deleted ON tasks(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX idx_task_labels_label ON task_labels(label_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 1,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_project ON attachments(project_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_project ON notes(project_id);

CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'idea',
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE whiteboards (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  viewport TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_whiteboards_project ON whiteboards(project_id);

CREATE TABLE wb_nodes (
  id TEXT PRIMARY KEY,
  whiteboard_id TEXT NOT NULL REFERENCES whiteboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  z INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wb_nodes_board ON wb_nodes(whiteboard_id);

CREATE TABLE wb_edges (
  id TEXT PRIMARY KEY,
  whiteboard_id TEXT NOT NULL REFERENCES whiteboards(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  source_handle TEXT,
  target_handle TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_wb_edges_board ON wb_edges(whiteboard_id);

CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  widgets TEXT NOT NULL DEFAULT '[]',
  layouts TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE daily_snapshots (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  viewed_at INTEGER,
  PRIMARY KEY (day, kind)
);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_created ON activity(created_at);
CREATE INDEX idx_activity_project ON activity(project_id, created_at);

CREATE TABLE focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  planned_seconds INTEGER NOT NULL,
  actual_seconds INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_focus_started ON focus_sessions(started_at);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  filters TEXT NOT NULL DEFAULT '{}',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE recent_items (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_recent_opened ON recent_items(opened_at);

CREATE TABLE notification_log (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Full-text search across tasks, projects, notes, boards and whiteboard text.
CREATE VIRTUAL TABLE search_fts USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  parent_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('task', new.id, new.project_id, new.title, new.description);
END;
CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, description, project_id, deleted_at ON tasks BEGIN
  DELETE FROM search_fts WHERE kind = 'task' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'task', new.id, new.project_id, new.title, new.description WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM search_fts WHERE kind = 'task' AND ref_id = old.id;
END;

CREATE TRIGGER projects_fts_ai AFTER INSERT ON projects WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('project', new.id, NULL, new.name, new.description);
END;
CREATE TRIGGER projects_fts_au AFTER UPDATE OF name, description, deleted_at ON projects BEGIN
  DELETE FROM search_fts WHERE kind = 'project' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'project', new.id, NULL, new.name, new.description WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER projects_fts_ad AFTER DELETE ON projects BEGIN
  DELETE FROM search_fts WHERE kind = 'project' AND ref_id = old.id;
END;

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('note', new.id, new.project_id, new.title, new.content);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, content, project_id, deleted_at ON notes BEGIN
  DELETE FROM search_fts WHERE kind = 'note' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'note', new.id, new.project_id, new.title, new.content WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM search_fts WHERE kind = 'note' AND ref_id = old.id;
END;

CREATE TRIGGER boards_fts_ai AFTER INSERT ON boards BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('board', new.id, new.project_id, new.name, '');
END;
CREATE TRIGGER boards_fts_au AFTER UPDATE OF name ON boards BEGIN
  DELETE FROM search_fts WHERE kind = 'board' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('board', new.id, new.project_id, new.name, '');
END;
CREATE TRIGGER boards_fts_ad AFTER DELETE ON boards BEGIN
  DELETE FROM search_fts WHERE kind = 'board' AND ref_id = old.id;
END;

CREATE TRIGGER whiteboards_fts_ai AFTER INSERT ON whiteboards WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body) VALUES ('whiteboard', new.id, new.project_id, new.name, '');
END;
CREATE TRIGGER whiteboards_fts_au AFTER UPDATE OF name, deleted_at, project_id ON whiteboards BEGIN
  DELETE FROM search_fts WHERE kind = 'whiteboard' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'whiteboard', new.id, new.project_id, new.name, '' WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER whiteboards_fts_ad AFTER DELETE ON whiteboards BEGIN
  DELETE FROM search_fts WHERE kind = 'whiteboard' AND ref_id = old.id;
END;

-- Searchable whiteboard object text (text cards, stickies, areas, links, shapes).
CREATE TRIGGER wb_nodes_fts_ai AFTER INSERT ON wb_nodes BEGIN
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'wb_node', new.id, new.whiteboard_id,
      COALESCE(json_extract(new.data, '$.title'), json_extract(new.data, '$.label'), ''),
      COALESCE(json_extract(new.data, '$.text'), json_extract(new.data, '$.url'), '')
    WHERE new.type IN ('text', 'sticky', 'area', 'link', 'shape');
END;
CREATE TRIGGER wb_nodes_fts_au AFTER UPDATE OF data ON wb_nodes BEGIN
  DELETE FROM search_fts WHERE kind = 'wb_node' AND ref_id = old.id;
  INSERT INTO search_fts(kind, ref_id, parent_id, title, body)
    SELECT 'wb_node', new.id, new.whiteboard_id,
      COALESCE(json_extract(new.data, '$.title'), json_extract(new.data, '$.label'), ''),
      COALESCE(json_extract(new.data, '$.text'), json_extract(new.data, '$.url'), '')
    WHERE new.type IN ('text', 'sticky', 'area', 'link', 'shape');
END;
CREATE TRIGGER wb_nodes_fts_ad AFTER DELETE ON wb_nodes BEGIN
  DELETE FROM search_fts WHERE kind = 'wb_node' AND ref_id = old.id;
END;
"#;

/// Phase 2: linked project folders and workspace trust, AI API account
/// metadata (secrets live in the OS credential store, never here), local AI
/// usage history, the favicon / link-metadata caches and the storage scan
/// cache. Purely additive: no existing table or id changes.
const MIGRATION_2: &str = r#"
-- A project may be linked to a folder on disk. The link is separate from the
-- project row: deleting a project never touches the folder itself.
CREATE TABLE project_folder_links (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  folder_key TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);
CREATE INDEX idx_folder_links_key ON project_folder_links(folder_key);

-- Trust decisions per canonical folder (exact path; never inherited by
-- parents, children or other folders).
CREATE TABLE trusted_workspaces (
  folder_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('trusted', 'restricted')),
  decided_at INTEGER NOT NULL
);

-- Per-project AI preferences (JSON: inherit, accountId, model, fileAccess).
ALTER TABLE projects ADD COLUMN ai_prefs TEXT NOT NULL DEFAULT '{}';

-- AI API credential profiles. Only non-sensitive metadata: the key itself is
-- stored in the OS credential store under `credential_ref`.
CREATE TABLE ai_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  name TEXT NOT NULL,
  credential_ref TEXT NOT NULL UNIQUE,
  key_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority REAL NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'none' CHECK (role IN ('primary', 'fallback', 'none')),
  failover_eligible INTEGER NOT NULL DEFAULT 1,
  preferred_model TEXT,
  models TEXT,
  organization_id TEXT,
  project_ref TEXT,
  observed_pool TEXT,
  budget_limit REAL,
  budget_unit TEXT CHECK (budget_unit IN ('tokens', 'usd')),
  budget_warn_percent INTEGER NOT NULL DEFAULT 80,
  budget_hard INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT,
  cooldown_until INTEGER,
  rate_limits TEXT,
  last_checked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_accounts_order ON ai_accounts(provider, priority);

-- One row per provider call made through Kern. Never prompts or responses.
CREATE TABLE ai_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  account_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  purpose TEXT NOT NULL DEFAULT 'request',
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  success INTEGER NOT NULL,
  error_category TEXT,
  http_status INTEGER,
  estimated_cost REAL
);
CREATE INDEX idx_ai_usage_started ON ai_usage_events(started_at);
CREATE INDEX idx_ai_usage_account ON ai_usage_events(account_id, started_at);

CREATE TABLE ai_failover_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  from_account_id TEXT,
  to_account_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_failover_created ON ai_failover_events(created_at);

-- Favicons cached per origin; `file` is relative to <data>/cache/favicons.
CREATE TABLE favicon_cache (
  origin TEXT PRIMARY KEY,
  file TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'none', 'error')),
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE link_metadata (
  url TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  site_name TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE storage_scan_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  scanned_at INTEGER NOT NULL
);

-- Favicons used to share the link-preview switch; carry the user's choice over.
INSERT OR IGNORE INTO settings(key, value, updated_at)
  SELECT 'privacy.favicons', value, updated_at FROM settings WHERE key = 'data.linkPreviews';
"#;

/// GitHub: repositories connected to projects and two-way issue links.
const MIGRATION_3: &str = r#"
CREATE TABLE project_repos (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT,
  html_url TEXT,
  sync_issues INTEGER NOT NULL DEFAULT 1,
  import_closed INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  last_sync_error TEXT,
  connected_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_repos_repo ON project_repos(lower(owner), lower(name));

-- One row per known issue. `task_id` becomes NULL when the task is deleted,
-- which marks the issue as ignored so it's never imported again.
-- synced_* hold the values at the last sync (the merge base).
CREATE TABLE task_issue_links (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL,
  html_url TEXT NOT NULL,
  remote_updated_at TEXT,
  synced_at INTEGER NOT NULL,
  synced_title TEXT,
  synced_body TEXT,
  synced_state TEXT,
  synced_labels TEXT,
  PRIMARY KEY (repo, issue_number)
);
CREATE UNIQUE INDEX idx_issue_links_task ON task_issue_links(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_issue_links_project ON task_issue_links(project_id);
"#;
