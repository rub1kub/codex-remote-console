import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type {
  ApprovalPolicy,
  CodexProfile,
  JsonRpcMessage,
  SandboxMode,
  ThreadListOptions
} from "./types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type BridgeEvents = {
  notification: [JsonRpcMessage];
  stderr: [string];
  status: [string];
};

const REQUEST_TIMEOUT_MS = 45_000;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuotePath(value: string) {
  if (value === "~") return "~";
  if (value.startsWith("~/")) {
    const rest = value
      .slice(2)
      .split("/")
      .filter(Boolean)
      .map(shellQuote)
      .join("/");
    return rest ? `~/${rest}` : "~";
  }
  return shellQuote(value);
}

function expandLocalPath(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function toSandboxPolicy(mode: SandboxMode, projectPath: string) {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [projectPath],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function buildThreadParams(profile: CodexProfile) {
  return {
    cwd: profile.projectPath,
    model: profile.model || null,
    approvalPolicy: profile.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: profile.sandboxMode,
    threadSource: "user"
  };
}

function buildTurnParams(
  profile: CodexProfile,
  threadId: string,
  text: string
) {
  return {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    cwd: profile.projectPath,
    approvalPolicy: profile.approvalPolicy,
    approvalsReviewer: "user",
    sandboxPolicy: toSandboxPolicy(profile.sandboxMode, profile.projectPath),
    model: profile.model || null
  };
}

function buildSpawn(profile: CodexProfile) {
  if (profile.mode === "local") {
    return {
      command: profile.codexBin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: expandLocalPath(profile.projectPath)
    };
  }

  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3"
  ];

  if (profile.port) {
    args.push("-p", String(profile.port));
  }
  if (profile.identityFile) {
    args.push("-i", expandLocalPath(profile.identityFile));
  }

  const innerCommand = [
    `cd ${shellQuotePath(profile.projectPath)}`,
    `${shellQuotePath(profile.codexBin)} app-server --listen stdio://`
  ].join(" && ");

  args.push(profile.sshTarget, `bash -lc ${shellQuote(innerCommand)}`);

  return {
    command: "ssh",
    args,
    cwd: process.cwd()
  };
}

export class CodexBridge extends EventEmitter<BridgeEvents> {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private activeThreadId?: string;
  private activeTurnId?: string;

  constructor(private readonly profile: CodexProfile) {
    super();
  }

  async start() {
    const spawnConfig = buildSpawn(this.profile);
    this.emit("status", "starting");

    this.proc = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: spawnConfig.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    this.proc.on("error", (error) => {
      this.rejectAll(error);
      this.emit("status", `error:${error.message}`);
    });

    this.proc.on("close", (code, signal) => {
      this.rejectAll(
        new Error(`codex app-server exited (${code ?? "no-code"} ${signal ?? ""})`)
      );
      this.emit("status", "closed");
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_remote_console",
        title: "Codex Remote Console",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized", {});
    this.emit("status", "ready");
  }

  dispose() {
    this.rejectAll(new Error("Connection closed."));
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = undefined;
  }

  async listThreads(options: ThreadListOptions = {}) {
    return this.request("thread/list", {
      limit: 80,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: options.archived ?? false,
      cwd: this.profile.projectPath,
      sourceKinds: ["cli", "appServer", "vscode", "exec"],
      searchTerm: options.searchTerm || null
    });
  }

  async readThread(threadId: string) {
    this.activeThreadId = threadId;
    return this.request("thread/read", { threadId, includeTurns: true });
  }

  async startThread() {
    const result = (await this.request(
      "thread/start",
      buildThreadParams(this.profile)
    )) as { thread?: { id?: string } };
    if (result.thread?.id) {
      this.activeThreadId = result.thread.id;
    }
    return result;
  }

  async resumeThread(threadId: string) {
    const result = (await this.request("thread/resume", {
      threadId,
      ...buildThreadParams(this.profile)
    })) as { thread?: { id?: string } };
    this.activeThreadId = result.thread?.id ?? threadId;
    return result;
  }

  async sendTurn(text: string, threadId?: string) {
    if (threadId && threadId !== this.activeThreadId) {
      await this.resumeThread(threadId);
    }

    let targetThreadId = threadId ?? this.activeThreadId;
    if (!targetThreadId) {
      const started = (await this.startThread()) as { thread?: { id?: string } };
      targetThreadId = started.thread?.id;
    }

    if (!targetThreadId) {
      throw new Error("Codex did not return a thread id.");
    }

    const result = (await this.request(
      "turn/start",
      buildTurnParams(this.profile, targetThreadId, text)
    )) as { turn?: { id?: string } };
    this.activeThreadId = targetThreadId;
    this.activeTurnId = result.turn?.id;
    return result;
  }

  async interrupt() {
    if (!this.activeThreadId || !this.activeTurnId) {
      return null;
    }
    return this.request("turn/interrupt", {
      threadId: this.activeThreadId,
      turnId: this.activeTurnId
    });
  }

  private request(method: string, params: unknown) {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not connected."));
    }

    const id = this.nextId++;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private notify(method: string, params: unknown) {
    if (this.proc?.stdin.writable) {
      this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  private handleLine(line: string) {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("stderr", line);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }

    if (message.method) {
      this.observeNotification(message);
      this.emit("notification", message);
    }
  }

  private observeNotification(message: JsonRpcMessage) {
    const params = message.params as
      | { threadId?: string; turn?: { id?: string } }
      | undefined;

    if (params?.threadId) {
      this.activeThreadId = params.threadId;
    }
    if (message.method === "turn/started" && params?.turn?.id) {
      this.activeTurnId = params.turn.id;
    }
    if (message.method === "turn/completed") {
      this.activeTurnId = undefined;
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
