export type ConnectionMode = "ssh" | "local";
export type ApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type SandboxMode = "danger-full-access" | "workspace-write" | "read-only";

export type CodexProfile = {
  id: string;
  name: string;
  mode: ConnectionMode;
  sshTarget: string;
  port?: number;
  identityFile?: string;
  projectPath: string;
  codexBin: string;
  model?: string;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  updateCommand?: string;
  quickCommands?: string[];
  createdAt: string;
  updatedAt: string;
};

export type AppPreferences = {
  theme: "system" | "light" | "dark";
  accentColor: string;
  connectionColor: string;
  userMessageColor: string;
  interfaceStyle: "native" | "session-first" | "calm-terminal";
  reasoningLevel: "low" | "medium" | "high" | "very-high";
  responseSpeed: "standard" | "fast";
  animations: boolean;
  compactMode: boolean;
  autoCheckUpdates: boolean;
  autoCheckAppUpdates: boolean;
  autoRefreshHistory: boolean;
  enterToSend: boolean;
  notifyOnCompletion: boolean;
  showDiagnostics: boolean;
  showTaskTimer: boolean;
  showTokenUsage: boolean;
  appUpdateChannel: "stable" | "preview";
  historyLimit: number;
  defaultUpdateCommand: string;
};

export type ThreadMetadata = {
  pinned?: boolean;
  title?: string;
  hidden?: boolean;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isGit?: boolean;
  hasPackageJson?: boolean;
};

export type ProjectFileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  modifiedAt?: number;
  isGit?: boolean;
  hasPackageJson?: boolean;
};

export type ProjectFileListing = {
  currentPath: string;
  parentPath?: string;
  entries: ProjectFileEntry[];
};

export type ProjectFileContent = {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
};

export type DirectoryListing = {
  currentPath: string;
  parentPath?: string;
  entries: DirectoryEntry[];
};

export type ProjectCommandResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ProjectDiagnostic = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
};

export type ProjectHealth = {
  cwd: string;
  isGit: boolean;
  dirtyFiles: number;
  packageJson: boolean;
  packageManager: string;
  scripts: string[];
  availableChecks: string[];
  diagnostics: ProjectDiagnostic[];
  sections: Array<{ title: string; body: string }>;
  command: string;
  exitCode: number | null;
};

export type ProjectDiff = {
  status: string;
  diff: string;
  command: string;
  exitCode: number | null;
};

export type FileSearchResult = {
  path: string;
  label: string;
};

export type McpServerInfo = {
  name: string;
  raw: string;
  status?: string;
};

export type McpStatus = {
  servers: McpServerInfo[];
  raw: string;
  command: string;
  exitCode: number | null;
};

export type SecretStoreStatus = {
  available: boolean;
  reason?: string;
  storedProfileIds: string[];
};

export type AppUpdateStatus = {
  current: string;
  latest: string;
  updateAvailable: boolean;
  releaseUrl: string;
  error?: string;
};

export type UserInput =
  | { type: "text"; text: string; text_elements?: unknown[] }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" | null }
  | { type: "localImage"; path: string; detail?: "auto" | "low" | "high" | "original" | null }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string; path: string };

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string | null }
  | { type: "custom"; instructions: string };

export type CodexCliStatus = {
  installed: string;
  latest: string;
  path: string;
  missing: boolean;
  updateAvailable: boolean;
  command: string;
  installCommand: string;
  message?: string;
  stdout: string;
  stderr: string;
  updateExitCode?: number | null;
  updateStdout?: string;
  updateStderr?: string;
};

export type ThreadItem = {
  type: string;
  id: string;
  content?: Array<{ type: string; text?: string }>;
  text?: string;
  command?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: Array<{ path?: string; operation?: string }>;
  [key: string]: unknown;
};

export type Turn = {
  id: string;
  items: ThreadItem[];
  status: string;
  startedAt?: number | null;
  completedAt?: number | null;
};

export type CodexThread = {
  id: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  cwd: string;
  source: string;
  name?: string | null;
  turns?: Turn[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  title?: string;
  muted?: boolean;
};

export type ServerMessage =
  | { type: "connection"; status: "idle" | "connecting" | "connected"; profile?: CodexProfile }
  | { type: "codexStatus"; status: string }
  | { type: "threads"; result: { data: CodexThread[]; nextCursor?: string | null } }
  | { type: "thread"; result: { thread: CodexThread } }
  | { type: "threadDeleted"; threadId: string; archived: boolean; archiveError?: string }
  | { type: "turn"; result: { turn: Turn } }
  | { type: "notification"; message: { id?: number | string; method?: string; params: any } }
  | { type: "log"; line: string }
  | { type: "codexCli"; phase: "checking" | "checked" | "updating" | "updated"; profileId?: string; result: CodexCliStatus | null }
  | { type: "error"; message: string }
  | { type: "interrupt"; result: unknown };
