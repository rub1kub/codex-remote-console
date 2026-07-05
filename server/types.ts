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

export type ThreadMetadata = {
  pinned?: boolean;
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
  animations: boolean;
  compactMode: boolean;
  autoCheckUpdates: boolean;
  autoRefreshHistory: boolean;
  enterToSend: boolean;
  showDiagnostics: boolean;
  historyLimit: number;
  defaultUpdateCommand: string;
};
