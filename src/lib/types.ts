// Domain types mirroring the Rust command payloads (camelCase).

export type TaskStatus = "inbox" | "todo" | "in_progress" | "blocked" | "completed";
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface Recurrence {
  freq: "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays?: number[]; // ISO 1 (Mon) .. 7 (Sun)
  dayOfMonth?: number | null;
  fromCompletion?: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  projectId: string | null;
  columnId: string | null;
  parentId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  startDate: string | null;
  estimateMinutes: number | null;
  trackedSeconds: number;
  sortOrder: number;
  boardOrder: number;
  pinned: boolean;
  recurrence: Recurrence | null;
  seriesId: string | null;
  reminderMinutes: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  labelIds: string[];
  subtaskCount: number;
  subtaskDone: number;
  attachmentCount: number;
  /** Linked GitHub issue. */
  issue?: { repo: string; number: number; url: string } | null;
}

export interface TaskQuery {
  ids?: string[];
  projectIds?: string[];
  noProject?: boolean;
  statuses?: TaskStatus[];
  excludeStatuses?: TaskStatus[];
  minPriority?: number;
  priorities?: number[];
  labelIds?: string[];
  dueFrom?: string;
  dueTo?: string;
  hasDue?: boolean;
  overdueAsOf?: string;
  includeCompleted?: boolean;
  completedFrom?: number;
  completedTo?: number;
  search?: string;
  parentId?: string;
  topLevelOnly?: boolean;
  includeArchived?: boolean;
  pinned?: boolean;
  limit?: number;
  order?: TaskOrder;
}

export type TaskOrder = "manual" | "due" | "priority" | "created" | "updated" | "title" | "completed";

export interface TaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  projectId?: string | null;
  columnId?: string | null;
  parentId?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  startDate?: string | null;
  estimateMinutes?: number | null;
  pinned?: boolean;
  recurrence?: Recurrence | null;
  labelIds?: string[];
  reminderMinutes?: number | null;
  sortOrder?: number;
  boardOrder?: number;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  projectId?: string | null;
  columnId?: string | null;
  parentId?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  startDate?: string | null;
  estimateMinutes?: number | null;
  reminderMinutes?: number | null;
  recurrence?: Recurrence | null;
  sortOrder?: number;
  boardOrder?: number;
  pinned?: boolean;
  archived?: boolean;
  labelIds?: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  addTrackedSeconds?: number;
}

export interface TaskUpdateResult {
  task: Task;
  previous: Task;
  spawned: Task | null;
}

export interface Label {
  id: string;
  name: string;
  color: string | null;
  taskCount: number;
}

export type ProjectTab = "overview" | "tasks" | "board" | "whiteboard" | "notes" | "files" | "code" | "activity";

export interface Project {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  accent: string | null;
  targetDate: string | null;
  groupId: string | null;
  pinned: boolean;
  sortOrder: number;
  defaultView: ProjectTab | null;
  hiddenTabs: ProjectTab[];
  defaultBoardId: string | null;
  lastOpenedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  taskTotal: number;
  taskDone: number;
  taskOverdue: number;
  taskDueSoon: number;
  lastActivityAt: number | null;
  /** Linked folder (canonical path) and its trust; availability via api.folders.get. */
  folderPath: string | null;
  folderTrust: Trust | null;
  aiPrefs: ProjectAiPrefs;
  /** Connected GitHub repository, "owner/name". */
  githubRepo: string | null;
}

export type Trust = "trusted" | "restricted";

export interface ProjectAiPrefs {
  /** Use the global routing settings (default true). */
  inherit?: boolean;
  accountId?: string | null;
  model?: string | null;
  /** Allow AI features to read this project's linked folder. */
  fileAccess?: boolean;
}

export interface FolderInfo {
  path: string;
  name: string;
  trust: Trust | null;
  linkedProjects: string[];
}

export interface FolderCapabilities {
  browse: boolean;
  openDocuments: boolean;
  openPrograms: boolean;
  modify: boolean;
  aiFiles: boolean;
  aiFilesReason: string | null;
}

export interface ProjectFolder {
  projectId: string;
  path: string;
  name: string;
  status: "ok" | "missing" | "not_directory" | "inaccessible";
  trust: Trust;
  capabilities: FolderCapabilities;
  linkedAt: number;
}

export interface FileEntry {
  name: string;
  rel: string;
  isDir: boolean;
  isLink: boolean;
  size: number | null;
  modified: number | null;
  program: boolean;
  sensitive: boolean;
  hidden: boolean;
}

export interface DirListing {
  rel: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface TrustRecord {
  path: string;
  trust: Trust;
  decidedAt: number;
  projects: string[];
  exists: boolean;
}

export interface ProjectInput {
  name: string;
  description?: string;
  icon?: string | null;
  accent?: string | null;
  targetDate?: string | null;
  groupId?: string | null;
  defaultView?: ProjectTab | null;
  folder?: { path: string; trust: Trust } | null;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  icon?: string | null;
  accent?: string | null;
  targetDate?: string | null;
  groupId?: string | null;
  pinned?: boolean;
  defaultView?: ProjectTab | null;
  hiddenTabs?: ProjectTab[];
  archived?: boolean;
  sortOrder?: number;
  aiPrefs?: ProjectAiPrefs;
}

export interface ProjectGroup {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
}

export interface BoardSettings {
  cardDensity?: "compact" | "expanded";
  hiddenMeta?: string[];
  sort?: "manual" | "due" | "priority" | "created" | "title";
  groupBy?: "none" | "priority" | "label";
  background?: "plain" | "dots" | "lines" | "sunken";
  showCompleted?: boolean;
  filter?: { search?: string; priorities?: number[]; labelIds?: string[] };
}

export interface Board {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
  settings: BoardSettings;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Column {
  id: string;
  boardId: string;
  name: string;
  sortOrder: number;
  status: TaskStatus | null;
  wipLimit: number | null;
  collapsed: boolean;
  width: number | null;
}

export interface BoardData {
  board: Board;
  columns: Column[];
  tasks: Task[];
}

export interface Note {
  id: string;
  title: string;
  content: string;
  projectId: string | null;
  pinned: boolean;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NoteMeta {
  id: string;
  title: string;
  excerpt: string;
  projectId: string | null;
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InboxItem {
  id: string;
  kind: "idea" | "link" | "note";
  content: string;
  createdAt: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Whiteboard {
  id: string;
  projectId: string | null;
  name: string;
  pinned: boolean;
  sortOrder: number;
  viewport: Viewport | null;
  nodeCount: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WbNodeRecord {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  z: number;
  parentId: string | null;
  locked: boolean;
  data: Record<string, unknown>;
}

export interface WbEdgeRecord {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  data: Record<string, unknown>;
}

export interface WhiteboardScene {
  whiteboard: Whiteboard;
  nodes: WbNodeRecord[];
  edges: WbEdgeRecord[];
}

export interface Attachment {
  id: string;
  taskId: string | null;
  projectId: string | null;
  name: string;
  path: string;
  absPath: string;
  managed: boolean;
  mime: string | null;
  size: number;
  exists: boolean;
  createdAt: number;
}

export interface StoredAsset {
  path: string;
  absPath: string;
  name: string;
  size: number;
}

export interface WidgetInstance {
  id: string;
  type: string;
  config: Record<string, unknown>;
  hidden?: boolean;
}

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export type GridLayouts = Record<string, GridItem[]>;

export interface Dashboard {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
  widgets: WidgetInstance[];
  layouts: GridLayouts;
  updatedAt: number;
}

export interface RundownData {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  highPriority: Task[];
  inProgress: Task[];
  pinned: Task[];
  completedToday: Task[];
  completedYesterday: Task[];
  projects: Project[];
}

export interface Snapshot<T = unknown> {
  day: string;
  kind: "morning" | "evening";
  data: T;
  createdAt: number;
  viewedAt: number | null;
}

export interface SnapshotMeta {
  day: string;
  kind: "morning" | "evening";
  createdAt: number;
  viewedAt: number | null;
}

export interface Activity {
  id: number;
  projectId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  createdAt: number;
}

export interface FocusSession {
  id: string;
  taskId: string | null;
  kind: "focus" | "short_break" | "long_break";
  plannedSeconds: number;
  actualSeconds: number;
  startedAt: number;
  endedAt: number;
  completed: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  icon: string | null;
  filters: TaskFilters;
  sortOrder: number;
}

/** User-facing filter model for task lists and saved views. */
export interface TaskFilters {
  projectIds?: string[];
  noProject?: boolean;
  statuses?: TaskStatus[];
  priorities?: number[];
  labelIds?: string[];
  due?: "any" | "overdue" | "today" | "week" | "next7" | "next30" | "none" | "dated";
  showCompleted?: boolean;
  search?: string;
  sort?: TaskOrder;
  group?: TaskGrouping;
}

export type TaskGrouping = "none" | "project" | "due" | "priority" | "status";

export interface RecentItem {
  entityType: "project" | "note" | "whiteboard";
  entityId: string;
  title: string;
  projectId: string | null;
  openedAt: number;
}

export interface SearchHit {
  kind: "task" | "project" | "note" | "board" | "whiteboard" | "wb_node" | "label" | "view";
  id: string;
  parentId: string | null;
  title: string;
  snippet: string;
  meta: string | null;
}

export interface Overview {
  openTasks: number;
  overdue: number;
  dueToday: number;
  inbox: number;
  activeProjects: number;
  completedToday: number;
  completedWeek: number;
}

export interface StorageStats {
  dbBytes: number;
  attachmentsBytes: number;
  attachmentsCount: number;
  tasks: number;
  projects: number;
  notes: number;
  whiteboards: number;
  whiteboardObjects: number;
  activityEntries: number;
  trashItems: number;
}

export interface TrashItem {
  kind: "project" | "task" | "note" | "whiteboard";
  id: string;
  title: string;
  projectId: string | null;
  deletedAt: number;
}

export interface ArchiveManifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  createdAt: number;
  kind: "auto" | "manual" | "pre-restore" | "export";
  counts: Record<string, number>;
  portable: boolean;
}

export interface BackupInfo {
  path: string;
  fileName: string;
  size: number;
  manifest: ArchiveManifest;
}

export interface RestorePreview {
  manifest: ArchiveManifest;
  valid: boolean;
  problems: string[];
  counts: Record<string, number>;
  hasAttachments: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  schemaVersion: number;
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  defaultBackupsDir: string;
  platform: string;
  tauriVersion: string;
  launchedAtLogin: boolean;
}

export interface LinkMetadata {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: string | null;
}

export type StorageCategoryId = "database" | "attachments" | "whiteboard" | "backups" | "cache" | "logs" | "other";

export interface StorageCategory {
  id: StorageCategoryId;
  bytes: number;
  files: number;
}

export interface StorageLocation {
  id: string;
  label: string;
  path: string;
  exists: boolean;
}

export interface LinkedFolderUsage {
  projectId: string;
  projectName: string;
  path: string;
  bytes: number;
  files: number;
  complete: boolean;
  note: string | null;
}

export interface StorageReport {
  scannedAt: number;
  durationMs: number;
  totalBytes: number;
  totalFiles: number;
  categories: StorageCategory[];
  locations: StorageLocation[];
  skipped: number;
  linked: LinkedFolderUsage[] | null;
}

export type StorageCleanup = "favicons" | "expiredPreviews" | "temporary" | "unusedWhiteboardAssets";

// ------------------------------------------------------------ AI API accounts

export type AiProvider = "anthropic" | "openai";
export type AiStatus = "ready" | "rate_limited" | "quota_reached" | "auth_error" | "permission_error" | "unavailable" | "disabled" | "unknown";
export type AiErrorCategory =
  | "rate_limited"
  | "spend_limit"
  | "insufficient_quota"
  | "invalid_key"
  | "permission"
  | "model_unavailable"
  | "network"
  | "overloaded"
  | "timeout"
  | "invalid_request"
  | "unknown";

export interface AiAccount {
  id: string;
  provider: AiProvider;
  name: string;
  keyHint: string | null;
  enabled: boolean;
  priority: number;
  role: "primary" | "fallback" | "none";
  failoverEligible: boolean;
  preferredModel: string | null;
  models: string[];
  organizationId: string | null;
  projectRef: string | null;
  observedPool: string | null;
  budgetLimit: number | null;
  budgetUnit: "tokens" | "usd" | null;
  budgetWarnPercent: number;
  budgetHard: boolean;
  status: AiStatus;
  statusDetail: string | null;
  cooldownUntil: number | null;
  /** Provider-reported rate-limit headers at the time of the last response. */
  rateLimits: { headers?: Record<string, string>; observedAt?: number } | null;
  lastCheckedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  month: { requests: number; tokens: number; cost: number | null };
}

export interface AiAccountInput {
  provider: AiProvider;
  name: string;
  apiKey: string;
  organizationId?: string | null;
  projectRef?: string | null;
  preferredModel?: string | null;
}

export interface AiAccountPatch {
  name?: string;
  enabled?: boolean;
  role?: "primary" | "fallback" | "none";
  failoverEligible?: boolean;
  preferredModel?: string | null;
  organizationId?: string | null;
  projectRef?: string | null;
  budgetLimit?: number | null;
  budgetUnit?: "tokens" | "usd";
  budgetWarnPercent?: number;
  budgetHard?: boolean;
}

export interface AiValidation {
  outcome: "authenticated" | "auth_failed" | "permission" | "unavailable" | "rate_limited" | "quota" | "network" | "unknown";
  message: string;
  httpStatus: number | null;
  models: string[];
  pool: string | null;
}

export interface AiFailure {
  category: AiErrorCategory;
  httpStatus: number | null;
  code: string | null;
  message: string;
  retryAfter: number | null;
  replaySafe: boolean;
}

export interface AiRouteRequest {
  requestId: string;
  prompt: string;
  system?: string | null;
  maxTokens?: number;
  accountId?: string | null;
  model?: string | null;
  projectId?: string | null;
  replayable?: boolean;
  purpose?: string;
}

export interface AiRouteOutcome {
  ok: boolean;
  text: string | null;
  accountId: string | null;
  accountName: string | null;
  provider: AiProvider | null;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null } | null;
  estimatedCost: number | null;
  stopReason: string | null;
  attempts: { accountId: string; accountName: string; model: string; ok: boolean; category: AiErrorCategory | null; message: string | null; durationMs: number }[];
  switches: { from: string; to: string; reason: string }[];
  warnings: string[];
  error: AiFailure | null;
}

export interface AiBreakdown {
  key: string;
  label: string;
  requests: number;
  tokens: number;
  cost: number | null;
}

export interface AiUsageEvent {
  id: number;
  requestId: string;
  accountId: string | null;
  accountName: string | null;
  provider: AiProvider;
  model: string | null;
  purpose: string;
  attempt: number;
  startedAt: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  success: boolean;
  errorCategory: string | null;
  httpStatus: number | null;
  estimatedCost: number | null;
}

export interface AiUsageSummary {
  days: { day: string; requests: number; failures: number; inputTokens: number; outputTokens: number }[];
  byProvider: AiBreakdown[];
  byModel: AiBreakdown[];
  byAccount: AiBreakdown[];
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number | null;
  recent: AiUsageEvent[];
  failovers: { id: number; requestId: string; fromName: string | null; toName: string | null; reason: string; detail: string | null; createdAt: number }[];
}

export interface AiSecurityReport {
  store: string;
  accounts: number;
  keysPresent: number;
  missing: string[];
}

export interface Favicon {
  origin: string;
  /** Absolute path of the locally cached icon. */
  path: string | null;
  status: "ok" | "none" | "error" | "disabled";
}

export const LINK_MIME = "text/uri-list";

// ------------------------------------------------------------ git & GitHub

export interface GitRemoteInfo {
  isRepo: boolean;
  originUrl: string | null;
  /** owner/name when origin is on github.com */
  github: string | null;
}

export interface GitChangedFile {
  path: string;
  code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  renamedFrom: string | null;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  shortHash: string;
  date: string;
}

export interface TodoItem {
  path: string;
  line: number;
  kind: string;
  text: string;
}

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  source: "cli" | "token" | null;
  cliInstalled: boolean;
  cliSignedIn: boolean;
  hasToken: boolean;
  error: string | null;
}

export interface RepoSummary {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string | null;
  htmlUrl: string;
  openIssues: number;
  updatedAt: string | null;
}

export interface ProjectRepo {
  projectId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string | null;
  htmlUrl: string | null;
  syncIssues: boolean;
  importClosed: boolean;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
  linkedIssues: number;
}

export interface SyncReport {
  imported: number;
  updatedInKern: number;
  updatedOnGithub: number;
  unchanged: number;
  errors: string[];
}

export interface PullInfo {
  number: number;
  title: string;
  htmlUrl: string;
  draft: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt: string;
  checks: "success" | "failure" | "pending" | "none";
  review: "approved" | "changes_requested" | "commented" | "none";
  linkedIssues: number[];
  linkedTasks: { id: string; title: string; done: boolean }[];
}

export interface RepoOverview {
  fullName: string;
  description: string | null;
  htmlUrl: string;
  defaultBranch: string | null;
  private: boolean;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  languages: [string, number][];
  readme: string | null;
  readmeSource: "local" | "github" | null;
}
