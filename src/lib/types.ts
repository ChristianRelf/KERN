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

export type ProjectTab = "overview" | "tasks" | "board" | "whiteboard" | "notes" | "files" | "activity";

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
}

export interface ProjectInput {
  name: string;
  description?: string;
  icon?: string | null;
  accent?: string | null;
  targetDate?: string | null;
  groupId?: string | null;
  defaultView?: ProjectTab | null;
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
