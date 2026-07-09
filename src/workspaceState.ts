export const WORKSPACE_STATE_VERSION = 1 as const;
export const WORKSPACE_STATE_STORAGE_KEY = "codex-remote-workspace-state";

export type WorkspaceChatTab = {
  profileId: string;
  threadId: string;
  title: string;
  path: string;
};

export type WorkspaceChatDraft = {
  text: string;
  updatedAt: number;
};

export type WorkspaceTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "waiting";

export type WorkspaceTaskMetrics = {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  filesChanged?: number;
  commandsRun?: number;
};

export type WorkspaceTaskCheckpoint = {
  id: string;
  ref: string;
  commit: string;
  baseCommit?: string;
  branch?: string;
  dirtyFiles: number;
  createdAt: string;
};

export type WorkspaceTaskRecord = {
  id: string;
  profileId: string;
  threadId?: string;
  title: string;
  path?: string;
  status: WorkspaceTaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  metrics?: WorkspaceTaskMetrics;
  checkpoint?: WorkspaceTaskCheckpoint;
  summary?: string;
  unread: boolean;
};

export type WorkspaceState = {
  openTabs: WorkspaceChatTab[];
  activeChatKey: string | null;
  drafts: Record<string, WorkspaceChatDraft>;
  tasks: WorkspaceTaskRecord[];
};

export type WorkspaceStateUpdateResult = {
  state: WorkspaceState;
  persisted: boolean;
};

type StoredWorkspaceState = {
  version: typeof WORKSPACE_STATE_VERSION;
  data: WorkspaceState;
};

const MAX_TABS = 40;
const MAX_DRAFTS = 250;
const MAX_TASKS = 500;
const MAX_LABEL_LENGTH = 500;
const MAX_PATH_LENGTH = 4_096;
const MAX_DRAFT_LENGTH = 200_000;
const MAX_SUMMARY_LENGTH = 20_000;
const taskStatuses = new Set<WorkspaceTaskStatus>([
  "running",
  "completed",
  "failed",
  "interrupted",
  "waiting"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength: number, allowEmpty = false) {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  if (!clean && !allowEmpty) return undefined;
  return (allowEmpty ? value : clean).slice(0, maxLength);
}

function cleanNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseTab(value: unknown): WorkspaceChatTab | null {
  if (!isRecord(value)) return null;
  const profileId = cleanString(value.profileId, MAX_LABEL_LENGTH);
  const threadId = cleanString(value.threadId, MAX_LABEL_LENGTH);
  const title = cleanString(value.title, MAX_LABEL_LENGTH);
  const path = cleanString(value.path, MAX_PATH_LENGTH);
  return profileId && threadId && title && path
    ? { profileId, threadId, title, path }
    : null;
}

function parseDraft(value: unknown): WorkspaceChatDraft | null {
  if (!isRecord(value)) return null;
  const text = cleanString(value.text, MAX_DRAFT_LENGTH, true);
  const updatedAt = cleanNumber(value.updatedAt);
  return text !== undefined && updatedAt !== undefined ? { text, updatedAt } : null;
}

function parseMetrics(value: unknown): WorkspaceTaskMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const metrics: WorkspaceTaskMetrics = {};
  const keys = [
    "durationMs",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "filesChanged",
    "commandsRun"
  ] as const;
  for (const key of keys) {
    const metric = cleanNumber(value[key]);
    if (metric !== undefined) metrics[key] = metric;
  }
  return Object.keys(metrics).length ? metrics : undefined;
}

function parseCheckpoint(value: unknown): WorkspaceTaskCheckpoint | undefined {
  if (!isRecord(value)) return undefined;
  const id = cleanString(value.id, MAX_LABEL_LENGTH);
  const ref = cleanString(value.ref, MAX_PATH_LENGTH);
  const commit = cleanString(value.commit, 128);
  const createdAt = cleanString(value.createdAt, 128);
  const dirtyFiles = cleanNumber(value.dirtyFiles);
  if (!id || !ref || !commit || !createdAt || dirtyFiles === undefined) return undefined;
  const checkpoint: WorkspaceTaskCheckpoint = { id, ref, commit, createdAt, dirtyFiles };
  const baseCommit = cleanString(value.baseCommit, 128);
  const branch = cleanString(value.branch, MAX_LABEL_LENGTH);
  if (baseCommit) checkpoint.baseCommit = baseCommit;
  if (branch) checkpoint.branch = branch;
  return checkpoint;
}

function parseTask(value: unknown): WorkspaceTaskRecord | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id, MAX_LABEL_LENGTH);
  const profileId = cleanString(value.profileId, MAX_LABEL_LENGTH);
  const title = cleanString(value.title, MAX_LABEL_LENGTH);
  const createdAt = cleanNumber(value.createdAt);
  const updatedAt = cleanNumber(value.updatedAt);
  const status = typeof value.status === "string" && taskStatuses.has(value.status as WorkspaceTaskStatus)
    ? value.status as WorkspaceTaskStatus
    : undefined;
  if (!id || !profileId || !title || createdAt === undefined || updatedAt === undefined || !status) {
    return null;
  }

  const task: WorkspaceTaskRecord = {
    id,
    profileId,
    title,
    status,
    createdAt,
    updatedAt,
    unread: value.unread === true
  };
  const threadId = cleanString(value.threadId, MAX_LABEL_LENGTH);
  const path = cleanString(value.path, MAX_PATH_LENGTH);
  const startedAt = cleanNumber(value.startedAt);
  const completedAt = cleanNumber(value.completedAt);
  const metrics = parseMetrics(value.metrics);
  const checkpoint = parseCheckpoint(value.checkpoint);
  const summary = cleanString(value.summary, MAX_SUMMARY_LENGTH);
  if (threadId) task.threadId = threadId;
  if (path) task.path = path;
  if (startedAt !== undefined) task.startedAt = startedAt;
  if (completedAt !== undefined) task.completedAt = completedAt;
  if (metrics) task.metrics = metrics;
  if (checkpoint) task.checkpoint = checkpoint;
  if (summary) task.summary = summary;
  return task;
}

function sanitizeWorkspaceState(value: unknown): WorkspaceState {
  if (!isRecord(value)) return createEmptyWorkspaceState();

  const openTabs: WorkspaceChatTab[] = [];
  const tabKeys = new Set<string>();
  if (Array.isArray(value.openTabs)) {
    for (const candidate of value.openTabs) {
      const tab = parseTab(candidate);
      if (!tab) continue;
      const key = workspaceChatKey(tab.profileId, tab.threadId);
      if (tabKeys.has(key)) continue;
      openTabs.push(tab);
      tabKeys.add(key);
      if (openTabs.length >= MAX_TABS) break;
    }
  }

  const drafts: Record<string, WorkspaceChatDraft> = {};
  if (isRecord(value.drafts)) {
    for (const [key, candidate] of Object.entries(value.drafts).slice(0, MAX_DRAFTS)) {
      const cleanKey = cleanString(key, MAX_LABEL_LENGTH * 2);
      const draft = parseDraft(candidate);
      if (cleanKey && draft) drafts[cleanKey] = draft;
    }
  }

  const tasks: WorkspaceTaskRecord[] = [];
  const taskIds = new Set<string>();
  if (Array.isArray(value.tasks)) {
    for (const candidate of value.tasks) {
      const task = parseTask(candidate);
      if (!task || taskIds.has(task.id)) continue;
      tasks.push(task);
      taskIds.add(task.id);
      if (tasks.length >= MAX_TASKS) break;
    }
  }

  const activeChatKey = typeof value.activeChatKey === "string" && tabKeys.has(value.activeChatKey)
    ? value.activeChatKey
    : null;
  return { openTabs, activeChatKey, drafts, tasks };
}

export function createEmptyWorkspaceState(): WorkspaceState {
  return { openTabs: [], activeChatKey: null, drafts: {}, tasks: [] };
}

export function workspaceChatKey(profileId: string, threadId: string) {
  return `${encodeURIComponent(profileId)}:${encodeURIComponent(threadId)}`;
}

export function loadWorkspaceState(storage: Storage | null = browserStorage()): WorkspaceState {
  if (!storage) return createEmptyWorkspaceState();
  try {
    const raw = storage.getItem(WORKSPACE_STATE_STORAGE_KEY);
    if (!raw) return createEmptyWorkspaceState();
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored) || stored.version !== WORKSPACE_STATE_VERSION) {
      return createEmptyWorkspaceState();
    }
    return sanitizeWorkspaceState(stored.data);
  } catch {
    return createEmptyWorkspaceState();
  }
}

export function saveWorkspaceState(
  state: WorkspaceState,
  storage: Storage | null = browserStorage()
) {
  if (!storage) return false;
  try {
    const stored: StoredWorkspaceState = {
      version: WORKSPACE_STATE_VERSION,
      data: sanitizeWorkspaceState(state)
    };
    storage.setItem(WORKSPACE_STATE_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function updateWorkspaceState(
  updater: (current: WorkspaceState) => WorkspaceState,
  storage: Storage | null = browserStorage()
): WorkspaceStateUpdateResult {
  const state = sanitizeWorkspaceState(updater(loadWorkspaceState(storage)));
  return { state, persisted: saveWorkspaceState(state, storage) };
}

export function clearWorkspaceState(storage: Storage | null = browserStorage()) {
  if (!storage) return false;
  try {
    storage.removeItem(WORKSPACE_STATE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
