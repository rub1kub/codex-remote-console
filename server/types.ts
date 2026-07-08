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

export type ProjectHealth = {
  cwd: string;
  isGit: boolean;
  dirtyFiles: number;
  packageJson: boolean;
  packageManager: string;
  scripts: string[];
  availableChecks: string[];
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

export type DirectoryListInput = Partial<
  Pick<
    CodexProfile,
    "mode" | "sshTarget" | "port" | "identityFile" | "projectPath"
  >
> & {
  path?: string;
};

export type ProfileInput = Partial<
  Omit<CodexProfile, "id" | "createdAt" | "updatedAt">
>;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export type ThreadListOptions = {
  searchTerm?: string;
  archived?: boolean;
  limit?: number;
};

export type ConnectionSecrets = {
  password?: string;
};

export type AppPreferences = {
  theme: "system" | "light" | "dark";
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
