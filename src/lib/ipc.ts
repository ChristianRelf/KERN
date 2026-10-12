// Typed client for the Rust command layer. All persistence goes through
// here; the UI never builds SQL.

import { invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

export class KernError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  try {
    return await invoke<R>(cmd, args);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && "message" in e) {
      const err = e as { code: string; message: string };
      throw new KernError(err.code, err.message);
    }
    throw new KernError("other", typeof e === "string" ? e : "Something went wrong.");
  }
}

/** Human-friendly message for a failed operation. */
export function describeError(e: unknown, fallback = "Couldn't save your changes."): string {
  if (e instanceof KernError) {
    switch (e.code) {
      case "invalid":
      case "not_found":
      case "network":
        return e.message.charAt(0).toUpperCase() + e.message.slice(1);
      case "busy":
        return "The database is busy. Try again in a moment.";
      case "io":
        return `File error: ${e.message.replace(/^file error: /, "")}`;
      default:
        return fallback;
    }
  }
  return fallback;
}

export const api = {
  settings: {
    getAll: () => call<Record<string, unknown>>("settings_get_all"),
    set: (entries: Record<string, unknown>) => call<void>("settings_set", { entries }),
    reset: (keys?: string[]) => call<void>("settings_reset", { keys: keys ?? null }),
  },
  tasks: {
    query: (query: T.TaskQuery) => call<T.Task[]>("tasks_query", { query }),
    get: (id: string) => call<T.Task>("task_get", { id }),
    create: (input: T.TaskInput) => call<T.Task>("task_create", { input }),
    update: (id: string, patch: T.TaskPatch) => call<T.TaskUpdateResult>("task_update", { id, patch }),
    updateMany: (ids: string[], patch: T.TaskPatch) => call<T.TaskUpdateResult[]>("tasks_update_many", { ids, patch }),
    patchBatch: (items: [string, T.TaskPatch][]) => call<void>("tasks_patch_batch", { items }),
    duplicate: (id: string) => call<T.Task>("task_duplicate", { id }),
    delete: (ids: string[]) => call<void>("tasks_delete", { ids }),
    restore: (ids: string[]) => call<void>("tasks_restore", { ids }),
    purge: (ids: string[]) => call<void>("tasks_purge", { ids }),
    reorder: (ids: string[], field?: "board" | "list") => call<void>("tasks_reorder", { ids, field: field ?? null }),
  },
  labels: {
    list: () => call<T.Label[]>("labels_list"),
    create: (name: string, color?: string | null) => call<T.Label>("label_create", { name, color: color ?? null }),
    update: (id: string, name?: string, color?: string) =>
      call<void>("label_update", { id, name: name ?? null, color: color ?? null }),
    delete: (id: string) => call<void>("label_delete", { id }),
  },
  projects: {
    list: (includeArchived = false) => call<T.Project[]>("projects_list", { includeArchived }),
    get: (id: string) => call<T.Project>("project_get", { id }),
    create: (input: T.ProjectInput) => call<T.Project>("project_create", { input }),
    update: (id: string, patch: T.ProjectPatch) => call<T.Project>("project_update", { id, patch }),
    /** Reorders projects; pass `group` to also move them into a group (null = ungrouped). */
    reorder: (ids: string[], group?: { groupId: string | null }) =>
      call<void>("projects_reorder", { ids, setGroup: group !== undefined, groupId: group?.groupId ?? null }),
    /** Full sidebar arrangement: order plus group membership, applied atomically. */
    arrange: (placements: { id: string; groupId: string | null }[]) => call<void>("projects_arrange", { placements }),
    resetOrder: () => call<void>("projects_reset_order"),
    duplicate: (id: string) => call<T.Project>("project_duplicate", { id }),
    delete: (id: string) => call<void>("project_delete", { id }),
    restore: (id: string) => call<void>("project_restore", { id }),
    touch: (id: string) => call<void>("project_touch", { id }),
  },
  ai: {
    list: () => call<T.AiAccount[]>("ai_accounts_list"),
    /** The key is write-only: it goes to the OS credential store and is never returned. */
    create: (input: T.AiAccountInput) => call<T.AiAccount>("ai_account_create", { input }),
    update: (id: string, patch: T.AiAccountPatch) => call<T.AiAccount>("ai_account_update", { id, patch }),
    replaceKey: (id: string, apiKey: string) => call<T.AiAccount>("ai_account_replace_key", { id, apiKey }),
    remove: (id: string) => call<void>("ai_account_delete", { id }),
    reorder: (ids: string[]) => call<void>("ai_accounts_reorder", { ids }),
    test: (id: string) => call<T.AiValidation>("ai_account_test", { id }),
    /** Validates a key without saving it. */
    testKey: (provider: T.AiProvider, apiKey: string, organizationId?: string | null, projectRef?: string | null) =>
      call<T.AiValidation>("ai_key_test", { provider, apiKey, organizationId: organizationId ?? null, projectRef: projectRef ?? null }),
    request: (request: T.AiRouteRequest) => call<T.AiRouteOutcome>("ai_request", { request }),
    cancel: (requestId: string) => call<void>("ai_request_cancel", { requestId }),
    usage: (since: number) => call<T.AiUsageSummary>("ai_usage", { since, tzOffsetMinutes: -new Date().getTimezoneOffset() }),
    clearHistory: () => call<void>("ai_history_clear"),
    security: () => call<T.AiSecurityReport>("ai_security_check"),
  },
  git: {
    available: () => call<string | null>("git_available"),
    remote: (projectId: string) => call<T.GitRemoteInfo>("git_remote", { projectId }),
    status: (projectId: string) => call<T.GitStatus>("git_status", { projectId }),
    diff: (projectId: string, path: string, staged: boolean, untracked: boolean) => call<string>("git_diff", { projectId, path, staged, untracked }),
    log: (projectId: string, limit?: number) => call<T.GitCommit[]>("git_log", { projectId, limit: limit ?? null }),
    branches: (projectId: string) => call<T.GitBranch[]>("git_branches", { projectId }),
    switch: (projectId: string, name: string, create = false) => call<void>("git_switch", { projectId, name, create }),
    sync: (projectId: string, action: "fetch" | "pull" | "push") => call<{ output: string }>("git_sync", { projectId, action }),
    clone: (repo: string, parent: string) => call<string>("git_clone", { repo, parent }),
    scanTodos: (projectId: string) => call<T.TodoItem[]>("project_scan_todos", { projectId }),
  },
  github: {
    status: () => call<T.GithubStatus>("github_status"),
    setToken: (token: string) => call<string>("github_set_token", { token }),
    clearToken: () => call<void>("github_clear_token"),
    repos: () => call<T.RepoSummary[]>("github_repos"),
    project: (projectId: string) => call<T.ProjectRepo | null>("github_project", { projectId }),
    connect: (projectId: string, repo: string, importClosed = false) => call<T.ProjectRepo>("github_connect", { projectId, repo, importClosed }),
    disconnect: (projectId: string) => call<void>("github_disconnect", { projectId }),
    update: (projectId: string, patch: { syncIssues?: boolean; importClosed?: boolean }) =>
      call<void>("github_update_connection", { projectId, syncIssues: patch.syncIssues ?? null, importClosed: patch.importClosed ?? null }),
    sync: (projectId: string) => call<T.SyncReport>("github_sync", { projectId }),
    syncTask: (taskId: string) => call<T.SyncReport>("github_sync_task", { taskId }),
    createIssue: (taskId: string) => call<string>("github_create_issue", { taskId }),
    pulls: (projectId: string) => call<T.PullInfo[]>("github_pulls", { projectId }),
    overview: (projectId: string) => call<T.RepoOverview>("github_overview", { projectId }),
  },
  folders: {
    inspect: (path: string) => call<T.FolderInfo>("folder_inspect", { path }),
    get: (projectId: string) => call<T.ProjectFolder | null>("project_folder_get", { projectId }),
    link: (projectId: string, path: string, trust: T.Trust) => call<T.ProjectFolder>("project_folder_link", { projectId, path, trust }),
    unlink: (projectId: string) => call<void>("project_folder_unlink", { projectId }),
    setTrust: (projectId: string, trust: T.Trust) => call<T.ProjectFolder>("project_folder_set_trust", { projectId, trust }),
    list: (projectId: string, rel: string) => call<T.DirListing>("project_files_list", { projectId, rel }),
    open: (projectId: string, rel: string, confirmedProgram = false) =>
      call<void>("project_file_open", { projectId, rel, confirmedProgram }),
    reveal: (projectId: string, rel: string) => call<void>("project_file_reveal", { projectId, rel }),
    path: (projectId: string, rel: string) => call<string>("project_file_path", { projectId, rel }),
    createFolder: (projectId: string, parentRel: string, name: string) =>
      call<string>("project_folder_create", { projectId, parentRel, name }),
    rename: (projectId: string, rel: string, newName: string) => call<string>("project_file_rename", { projectId, rel, newName }),
    trusted: () => call<T.TrustRecord[]>("trusted_folders_list"),
    /** trust = null forgets the decision. */
    updateTrusted: (path: string, trust: T.Trust | null) => call<void>("trusted_folder_update", { path, trust }),
  },
  groups: {
    list: () => call<T.ProjectGroup[]>("groups_list"),
    create: (name: string) => call<T.ProjectGroup>("group_create", { name }),
    update: (id: string, patch: { name?: string; collapsed?: boolean; sortOrder?: number }) =>
      call<void>("group_update", {
        id,
        name: patch.name ?? null,
        collapsed: patch.collapsed ?? null,
        sortOrder: patch.sortOrder ?? null,
      }),
    delete: (id: string) => call<void>("group_delete", { id }),
    reorder: (ids: string[]) => call<void>("groups_reorder", { ids }),
  },
  boards: {
    list: (projectId?: string) => call<T.Board[]>("boards_list", { projectId: projectId ?? null }),
    get: (id: string) => call<T.BoardData>("board_get", { id }),
    create: (projectId: string, name: string) => call<T.Board>("board_create", { projectId, name }),
    update: (id: string, patch: { name?: string; settings?: T.BoardSettings; makeDefault?: boolean }) =>
      call<T.Board>("board_update", { id, patch }),
    delete: (id: string) => call<void>("board_delete", { id }),
    createColumn: (boardId: string, name: string, status?: T.TaskStatus | null) =>
      call<T.Column>("column_create", { boardId, name, status: status ?? null }),
    updateColumn: (
      id: string,
      patch: { name?: string; status?: T.TaskStatus | null; wipLimit?: number | null; collapsed?: boolean; width?: number | null },
    ) => call<void>("column_update", { id, patch }),
    deleteColumn: (id: string, moveTo?: string | null) => call<void>("column_delete", { id, moveTo: moveTo ?? null }),
    reorderColumns: (ids: string[]) => call<void>("columns_reorder", { ids }),
  },
  notes: {
    list: (projectId?: string | null, includeArchived = false) =>
      call<T.NoteMeta[]>("notes_list", { projectId: projectId ?? null, includeArchived }),
    get: (id: string) => call<T.Note>("note_get", { id }),
    create: (input: { title?: string; content?: string; projectId?: string | null }) =>
      call<T.Note>("note_create", {
        title: input.title ?? null,
        content: input.content ?? null,
        projectId: input.projectId ?? null,
      }),
    update: (
      id: string,
      patch: { title?: string; content?: string; projectId?: string | null; pinned?: boolean; archived?: boolean },
    ) => call<T.Note>("note_update", { id, patch }),
    delete: (ids: string[]) => call<void>("notes_delete", { ids }),
    restore: (ids: string[]) => call<void>("notes_restore", { ids }),
  },
  inbox: {
    list: () => call<T.InboxItem[]>("inbox_list"),
    add: (content: string, kind?: T.InboxItem["kind"]) => call<T.InboxItem>("inbox_add", { content, kind: kind ?? null }),
    update: (id: string, content: string) => call<void>("inbox_update", { id, content }),
    delete: (id: string) => call<T.InboxItem | null>("inbox_delete", { id }),
    restore: (item: T.InboxItem) => call<void>("inbox_restore", { item }),
    convert: (id: string, to: "task" | "note", projectId?: string | null) =>
      call<{ kind: string; id: string }>("inbox_convert", { id, to, projectId: projectId ?? null }),
  },
  whiteboards: {
    list: (projectId?: string | null) => call<T.Whiteboard[]>("whiteboards_list", { projectId: projectId ?? null }),
    get: (id: string) => call<T.WhiteboardScene>("whiteboard_get", { id }),
    preview: (id: string) => call<T.WhiteboardScene>("whiteboard_preview", { id }),
    create: (name: string, projectId?: string | null) =>
      call<T.Whiteboard>("whiteboard_create", { name, projectId: projectId ?? null }),
    update: (
      id: string,
      patch: { name?: string; pinned?: boolean; viewport?: T.Viewport; projectId?: string | null; sortOrder?: number },
    ) => call<T.Whiteboard>("whiteboard_update", { id, patch }),
    save: (id: string, nodes: T.WbNodeRecord[], edges: T.WbEdgeRecord[], viewport?: T.Viewport | null) =>
      call<void>("whiteboard_save", { id, nodes, edges, viewport: viewport ?? null }),
    duplicate: (id: string) => call<T.Whiteboard>("whiteboard_duplicate", { id }),
    import: (document: unknown, projectId?: string | null) =>
      call<T.Whiteboard>("whiteboard_import", { document, projectId: projectId ?? null }),
    delete: (id: string) => call<void>("whiteboard_delete", { id }),
    restore: (id: string) => call<void>("whiteboard_restore", { id }),
  },
  attachments: {
    list: (q: { taskId?: string; projectId?: string }) =>
      call<T.Attachment[]>("attachments_list", { taskId: q.taskId ?? null, projectId: q.projectId ?? null }),
    add: (sourcePath: string, target: { taskId?: string; projectId?: string }, managed = true) =>
      call<T.Attachment>("attachment_add", {
        sourcePath,
        taskId: target.taskId ?? null,
        projectId: target.projectId ?? null,
        managed,
      }),
    delete: (id: string) => call<void>("attachment_delete", { id }),
    addLink: (url: string, target: { taskId?: string; projectId?: string }, title?: string | null) =>
      call<T.Attachment>("attachment_add_link", { url, title: title ?? null, taskId: target.taskId ?? null, projectId: target.projectId ?? null }),
    rename: (id: string, name: string) => call<void>("attachment_rename", { id, name }),
    importAsset: (sourcePath: string) => call<T.StoredAsset>("asset_import", { sourcePath }),
    importAssetBytes: (name: string, dataBase64: string) =>
      call<T.StoredAsset>("asset_import_bytes", { name, dataBase64 }),
  },
  dashboards: {
    list: () => call<T.Dashboard[]>("dashboards_list"),
    create: (name: string, widgets: T.WidgetInstance[], layouts: T.GridLayouts) =>
      call<T.Dashboard>("dashboard_create", { name, widgets, layouts }),
    update: (
      id: string,
      patch: { name?: string; widgets?: T.WidgetInstance[]; layouts?: T.GridLayouts; isDefault?: boolean; sortOrder?: number },
    ) => call<T.Dashboard>("dashboard_update", { id, patch }),
    delete: (id: string) => call<void>("dashboard_delete", { id }),
  },
  daily: {
    data: (args: {
      today: string;
      horizonEnd: string;
      dayStart: number;
      yesterdayStart: number;
      tomorrowStart: number;
      projectIds?: string[] | null;
    }) => call<T.RundownData>("rundown_data", { ...args, projectIds: args.projectIds ?? null }),
    getSnapshot: <D>(day: string, kind: "morning" | "evening") =>
      call<T.Snapshot<D> | null>("snapshot_get", { day, kind }),
    saveSnapshot: (day: string, kind: "morning" | "evening", data: unknown, replace = false) =>
      call<void>("snapshot_save", { day, kind, data, replace }),
    markViewed: (day: string, kind: "morning" | "evening") => call<void>("snapshot_mark_viewed", { day, kind }),
    listSnapshots: (limit?: number) => call<T.SnapshotMeta[]>("snapshots_list", { limit: limit ?? null }),
  },
  focus: {
    record: (input: Omit<T.FocusSession, "id">) => call<T.FocusSession>("focus_record", { input }),
    list: (from: number, to: number) => call<T.FocusSession[]>("focus_sessions_list", { from, to }),
    schedule: (endAt: number, title: string, body: string) => call<void>("focus_schedule", { endAt, title, body }),
    cancel: () => call<void>("focus_cancel"),
  },
  activity: {
    list: (projectId?: string | null, limit?: number, before?: number) =>
      call<T.Activity[]>("activity_list", { projectId: projectId ?? null, limit: limit ?? null, before: before ?? null }),
  },
  recent: {
    list: (limit?: number) => call<T.RecentItem[]>("recent_list", { limit: limit ?? null }),
  },
  views: {
    list: () => call<T.SavedView[]>("views_list"),
    create: (name: string, filters: T.TaskFilters, icon?: string | null) =>
      call<T.SavedView>("view_create", { name, filters, icon: icon ?? null }),
    update: (id: string, patch: { name?: string; icon?: string; filters?: T.TaskFilters }) =>
      call<void>("view_update", { id, name: patch.name ?? null, icon: patch.icon ?? null, filters: patch.filters ?? null }),
    delete: (id: string) => call<void>("view_delete", { id }),
    reorder: (ids: string[]) => call<void>("views_reorder", { ids }),
  },
  search: (query: string, limit?: number) => call<T.SearchHit[]>("search", { query, limit: limit ?? null }),
  stats: {
    overview: (today: string, dayStart: number, weekStart: number) =>
      call<T.Overview>("stats_overview", { today, dayStart, weekStart }),
    completions: (from: number, to: number) => call<number[]>("stats_completions", { from, to }),
    dueCounts: (from: string, to: string) => call<[string, number, number][]>("stats_due_counts", { from, to }),
    storage: () => call<T.StorageStats>("storage_stats"),
  },
  storage: {
    /** Last scan result without scanning. */
    report: () => call<T.StorageReport | null>("storage_report"),
    scan: (includeLinked: boolean) => call<T.StorageReport>("storage_scan", { includeLinked }),
    cancel: () => call<void>("storage_scan_cancel"),
    /** Returns bytes freed. */
    cleanup: (what: T.StorageCleanup) => call<number>("storage_cleanup", { what }),
  },
  trash: {
    list: () => call<T.TrashItem[]>("trash_list"),
    purge: (kind: string, id: string) => call<void>("trash_purge", { kind, id }),
    empty: () => call<number>("trash_empty"),
  },
  data: {
    backupCreate: (destDir?: string | null) => call<T.BackupInfo>("backup_create", { destDir: destDir ?? null }),
    backupsList: () => call<T.BackupInfo[]>("backups_list"),
    backupPreview: (path: string) => call<T.RestorePreview>("backup_preview", { path }),
    backupRestore: (path: string) => call<T.BackupInfo>("backup_restore", { path }),
    backupDelete: (path: string) => call<void>("backup_delete", { path }),
    exportAll: (path: string) => call<T.BackupInfo>("export_all", { path }),
    exportTasksCsv: (path: string) => call<void>("export_tasks_csv", { path }),
    exportNotesMarkdown: (dir: string) => call<number>("export_notes_markdown", { dir }),
    exportProjectsJson: (path: string, ids?: string[] | null) =>
      call<void>("export_projects_json", { path, ids: ids ?? null }),
    dataDirSize: () => call<number>("data_dir_size"),
  },
  system: {
    info: () => call<T.AppInfo>("app_info"),
    checkForUpdate: () => call<T.UpdateInfo>("check_for_update"),
    open: (target: string) => call<void>("open_external", { target }),
    reveal: (path: string) => call<void>("reveal_path", { path }),
    exists: (path: string) => call<boolean>("path_exists", { path }),
    writeText: (path: string, contents: string) => call<void>("write_text_file", { path, contents }),
    writeBinary: (path: string, dataBase64: string) => call<void>("write_binary_file", { path, dataBase64 }),
    readText: (path: string) => call<string>("read_text_file", { path }),
    linkMetadata: (url: string) => call<T.LinkMetadata>("link_metadata", { url }),
    favicon: (url: string) => call<T.Favicon>("favicon_get", { url }),
    setTrayVisible: (visible: boolean) => call<void>("tray_set_visible", { visible }),
    quit: () => call<void>("quit_app"),
    showWindow: () => call<void>("show_main_window"),
  },
};
