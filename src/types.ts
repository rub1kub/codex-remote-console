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
  createdAt: string;
  updatedAt: string;
};

export type AppPreferences = {
  theme: "system" | "light" | "dark";
  animations: boolean;
  compactMode: boolean;
  autoCheckUpdates: boolean;
  autoRefreshHistory: boolean;
  enterToSend: boolean;
  showDiagnostics: boolean;
  historyLimit: number;
  defaultUpdateCommand: string;
};

export type CodexCliStatus = {
  installed: string;
  latest: string;
  path: string;
  updateAvailable: boolean;
  command: string;
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
  | { type: "turn"; result: { turn: Turn } }
  | { type: "notification"; message: { method: string; params: any } }
  | { type: "log"; line: string }
  | { type: "codexCli"; phase: "checking" | "checked" | "updating" | "updated"; result: CodexCliStatus | null }
  | { type: "error"; message: string }
  | { type: "interrupt"; result: unknown };
