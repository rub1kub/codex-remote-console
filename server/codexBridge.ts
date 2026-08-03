import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Writable } from "node:stream";
import { Client, type ClientChannel } from "ssh2";

import type {
  CodexProfile,
  ConnectionSecrets,
  JsonRpcMessage,
  ReviewTarget,
  SandboxMode,
  ThreadListOptions,
  UserInput
} from "./types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ModelListPage = {
  data?: unknown[];
  nextCursor?: string | null;
};

type ThreadReadResult = {
  thread?: Record<string, unknown> & { turns?: unknown[] };
};

type ThreadTurn = Record<string, unknown> & {
  id?: string;
  items?: unknown[];
};

type ThreadTurnsPage = {
  data?: ThreadTurn[];
  nextCursor?: string | null;
};

type BridgeEvents = {
  notification: [JsonRpcMessage];
  stderr: [string];
  status: [string];
};

const REQUEST_TIMEOUT_MS = 45_000;
const HISTORY_PAGE_TIMEOUT_MS = 60_000;
const LEGACY_THREAD_READ_TIMEOUT_MS = 180_000;
const HISTORY_TURN_PAGE_SIZE = 20;

function isUnsupportedHistoryPagination(error: unknown) {
  return error instanceof Error &&
    /method not found|unknown method|unsupported method|not supported|not implemented/i.test(error.message);
}

// A brand-new thread with no turns yet (e.g. right after creation, before the
// first message is sent) is not an error: there is simply nothing to list.
function isUnmaterializedThreadError(error: unknown) {
  return error instanceof Error &&
    /not materialized|before first user message/i.test(error.message);
}

function hasDisplayableHistoryItems(turns: ThreadTurn[]) {
  return turns.some((turn) => (turn.items ?? []).some((item) => {
    if (!item || typeof item !== "object") return false;
    const value = item as Record<string, unknown>;

    if (value.type === "userMessage") {
      return Array.isArray(value.content) && value.content.some((part) => {
        if (!part || typeof part !== "object") return false;
        const contentPart = part as Record<string, unknown>;
        return contentPart.type === "text" && typeof contentPart.text === "string" && contentPart.text.trim().length > 0;
      });
    }

    if (value.type === "agentMessage" || value.type === "plan") {
      return typeof value.text === "string" && value.text.trim().length > 0;
    }

    return value.type === "commandExecution" || value.type === "fileChange";
  }));
}

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
  input: UserInput[],
  options: { effort?: string | null; serviceTier?: string | null } = {}
) {
  return {
    threadId,
    input,
    cwd: profile.projectPath,
    approvalPolicy: profile.approvalPolicy,
    approvalsReviewer: "user",
    sandboxPolicy: toSandboxPolicy(profile.sandboxMode, profile.projectPath),
    model: profile.model || null,
    effort: options.effort ?? null,
    serviceTier: options.serviceTier ?? null
  };
}

function buildTurnInput(text: string, input: UserInput[] = []) {
  const cleanText = text.trim();
  const nextInput = input.length
    ? input
    : cleanText
      ? [{ type: "text" as const, text: cleanText, text_elements: [] }]
      : [];

  if (cleanText && !nextInput.some((item) => item.type === "text")) {
    return [{ type: "text" as const, text: cleanText, text_elements: [] }, ...nextInput];
  }

  return nextInput;
}

function codexMissingMessage(profile: CodexProfile) {
  const target =
    profile.mode === "local"
      ? "на этом компьютере"
      : `на сервере ${profile.sshTarget}`;
  return `Codex CLI не найден ${target}. Откройте Настройки -> Codex, нажмите "Установить" и подключитесь к проекту снова.`;
}

function codexBrokenMessage(profile: CodexProfile) {
  const target =
    profile.mode === "local"
      ? "на этом компьютере"
      : `на сервере ${profile.sshTarget}`;
  return `Установка Codex CLI повреждена ${target}. Отсутствует платформенный пакет Codex. Нажмите "Восстановить Codex" и подключитесь снова.`;
}

function isMissingCodexError(value: string) {
  return /Codex CLI не найден|command not found|ENOENT|No such file or directory/i.test(value);
}

function bridgeCloseError(fallback: string, stderr: string, profile: CodexProfile) {
  if (/Missing optional dependency @openai\/codex-/i.test(stderr)) {
    return new Error(codexBrokenMessage(profile));
  }
  if (isMissingCodexError(stderr)) {
    return new Error(codexMissingMessage(profile));
  }
  const details = stderr.trim();
  return new Error(details ? `${fallback}: ${details}` : fallback);
}

function buildCodexPreflight(profile: CodexProfile) {
  const codexBin = shellQuotePath(profile.codexBin || "codex");
  return [
    `if ! command -v ${codexBin} >/dev/null 2>&1; then`,
    `printf "%s\\n" ${shellQuote(codexMissingMessage(profile))} >&2;`,
    "exit 127;",
    "fi"
  ].join(" ");
}

function buildRemoteCommand(profile: CodexProfile) {
  return [
    buildCodexPreflight(profile),
    `cd ${shellQuotePath(profile.projectPath)}`,
    `${shellQuotePath(profile.codexBin)} app-server --listen stdio://`
  ].join(" && ");
}

// npm installs the Codex CLI on Windows as a codex.cmd shim, which Node
// refuses to spawn directly. Resolve the real target and, for .cmd/.bat
// shims, run it through cmd.exe with verbatim quoting.
function resolveWindowsExecutable(binary: string) {
  const expanded = expandLocalPath(binary);
  if (expanded.includes("/") || expanded.includes("\\")) {
    if (existsSync(expanded)) return expanded;
    for (const extension of [".exe", ".cmd", ".bat"]) {
      if (existsSync(expanded + extension)) return expanded + extension;
    }
    return "";
  }

  const located = spawnSync("where.exe", [expanded], {
    encoding: "utf8",
    windowsHide: true
  });
  if (located.status !== 0) return "";
  const lines = located.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /\.(exe|cmd|bat)$/i.test(line)) || lines[0] || "";
}

type SpawnConfig = {
  command: string;
  args: string[];
  cwd: string;
  verbatimArguments?: boolean;
};

function buildSpawn(profile: CodexProfile): SpawnConfig {
  if (profile.mode === "local") {
    const cwd = expandLocalPath(profile.projectPath);
    const appServerArgs = ["app-server", "--listen", "stdio://"];

    if (process.platform === "win32") {
      const resolved = resolveWindowsExecutable(profile.codexBin || "codex");
      if (!resolved) {
        throw new Error(codexMissingMessage(profile));
      }
      if (/\.(cmd|bat)$/i.test(resolved)) {
        return {
          command: "cmd.exe",
          args: ["/d", "/s", "/c", `""${resolved}" ${appServerArgs.join(" ")}"`],
          cwd,
          verbatimArguments: true
        };
      }
      return { command: resolved, args: appServerArgs, cwd };
    }

    return {
      command: profile.codexBin,
      args: appServerArgs,
      cwd
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

  args.push(profile.sshTarget, `bash -lc ${shellQuote(buildRemoteCommand(profile))}`);

  return {
    command: "ssh",
    args,
    cwd: process.cwd()
  };
}

function parseSshTarget(target: string, port?: number) {
  const atIndex = target.lastIndexOf("@");
  const username =
    atIndex > 0 ? target.slice(0, atIndex) : os.userInfo().username;
  let host = atIndex > 0 ? target.slice(atIndex + 1) : target;
  let parsedPort = port;

  const colonIndex = host.lastIndexOf(":");
  if (!parsedPort && colonIndex > 0 && !host.includes("]")) {
    const maybePort = Number(host.slice(colonIndex + 1));
    if (Number.isInteger(maybePort) && maybePort > 0 && maybePort <= 65535) {
      parsedPort = maybePort;
      host = host.slice(0, colonIndex);
    }
  }

  return { host, username, port: parsedPort ?? 22 };
}

export class CodexBridge extends EventEmitter<BridgeEvents> {
  private proc?: ChildProcessWithoutNullStreams;
  private sshClient?: Client;
  private rpcStream?: Writable;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private activeThreadId?: string;
  private activeTurnId?: string;
  private lastStderr = "";

  constructor(
    private readonly profile: CodexProfile,
    private readonly secrets: ConnectionSecrets = {}
  ) {
    super();
  }

  async start() {
    this.emit("status", "starting");

    if (this.profile.mode === "ssh" && this.secrets.password) {
      await this.startSsh2();
    } else {
      this.startSpawn();
    }

    await this.request("initialize", {
      clientInfo: {
        name: "codex_remote_console",
        title: "Codex Remote Console",
        version: "1.6.0"
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
    if (this.rpcStream && !this.rpcStream.destroyed) {
      this.rpcStream.end();
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.sshClient?.end();
    this.rpcStream = undefined;
    this.proc = undefined;
    this.sshClient = undefined;
  }

  async listThreads(options: ThreadListOptions = {}) {
    return this.request("thread/list", {
      limit: options.limit ?? 80,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: options.archived ?? false,
      cwd: this.profile.projectPath,
      sourceKinds: ["cli", "appServer", "vscode", "exec"],
      searchTerm: options.searchTerm || null
    });
  }

  async listModels() {
    const data: unknown[] = [];
    let cursor: string | null = null;

    do {
      const page = (await this.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false
      })) as ModelListPage;
      if (Array.isArray(page.data)) data.push(...page.data);
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    } while (cursor);

    return { data, nextCursor: null };
  }

  async readThread(threadId: string) {
    // Reading history does not attach the app-server turn state.
    // Old threads must be resumed before sending a new turn.
    const metadata = (await this.request("thread/read", {
      threadId,
      includeTurns: false
    })) as ThreadReadResult;

    try {
      const turns = await this.readThreadTurns(threadId);
      if (!hasDisplayableHistoryItems(turns)) {
        return this.request(
          "thread/read",
          { threadId, includeTurns: true },
          LEGACY_THREAD_READ_TIMEOUT_MS
        );
      }
      if (!metadata.thread) return metadata;
      return {
        ...metadata,
        thread: {
          ...metadata.thread,
          turns
        }
      };
    } catch (error) {
      if (isUnmaterializedThreadError(error)) {
        if (!metadata.thread) return metadata;
        return { ...metadata, thread: { ...metadata.thread, turns: [] } };
      }
      if (!isUnsupportedHistoryPagination(error)) throw error;
      return this.request(
        "thread/read",
        { threadId, includeTurns: true },
        LEGACY_THREAD_READ_TIMEOUT_MS
      );
    }
  }

  private async readThreadTurns(threadId: string) {
    const page = (await this.request(
      "thread/turns/list",
      {
        threadId,
        cursor: null,
        limit: HISTORY_TURN_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "summary"
      },
      HISTORY_PAGE_TIMEOUT_MS
    )) as ThreadTurnsPage;

    return (page.data ?? []).map((turn) => {
      if (!turn.id) throw new Error("Codex returned a history turn without an id.");
      return {
        ...turn,
        items: Array.isArray(turn.items) ? turn.items : [],
        itemsView: "summary"
      };
    }).reverse();
  }

  async archiveThread(threadId: string) {
    return this.request("thread/archive", { threadId });
  }

  async deleteThread(threadId: string) {
    return this.request("thread/delete", { threadId });
  }

  async unarchiveThread(threadId: string) {
    return this.request("thread/unarchive", { threadId });
  }

  async forkThread(threadId: string) {
    const result = (await this.request("thread/fork", {
      threadId,
      ...buildThreadParams(this.profile)
    })) as { thread?: { id?: string } };
    if (result.thread?.id) {
      this.activeThreadId = result.thread.id;
    }
    return result;
  }

  async compactThread(threadId: string) {
    return this.request("thread/compact/start", { threadId });
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

  async sendTurn(
    text: string,
    threadId?: string,
    input: UserInput[] = [],
    options: { effort?: string | null; serviceTier?: string | null } = {}
  ) {
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

    const turnInput = buildTurnInput(text, input);
    if (turnInput.length === 0) {
      throw new Error("Message is empty.");
    }

    const result = (await this.request(
      "turn/start",
      buildTurnParams(this.profile, targetThreadId, turnInput, options)
    )) as { turn?: { id?: string } };
    this.activeThreadId = targetThreadId;
    this.activeTurnId = result.turn?.id;
    return result;
  }

  async startReview(target: ReviewTarget, threadId?: string) {
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

    const result = await this.request("review/start", {
      threadId: targetThreadId,
      target,
      delivery: null
    });
    this.activeThreadId = targetThreadId;
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

  async readAccountRateLimits() {
    return this.request("account/rateLimits/read", {});
  }

  async listSkills(forceReload = false) {
    return this.request("skills/list", {
      cwds: [this.profile.projectPath],
      forceReload
    });
  }

  respondRequest(id: number | string, result: unknown) {
    if (!this.canWriteRpc()) {
      throw new Error("Codex app-server is not connected.");
    }
    this.writeRpc({ id, result });
  }

  private startSpawn() {
    const spawnConfig = buildSpawn(this.profile);

    this.proc = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: spawnConfig.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: spawnConfig.verbatimArguments
    });
    this.rpcStream = this.proc.stdin;

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8");
      this.lastStderr += line;
      this.emit("stderr", line);
    });

    this.proc.on("error", (error) => {
      const nextError = isMissingCodexError(error.message)
        ? new Error(codexMissingMessage(this.profile))
        : error;
      this.rejectAll(nextError);
      this.emit("status", `error:${nextError.message}`);
    });

    this.proc.on("close", (code, signal) => {
      this.rejectAll(
        bridgeCloseError(
          `codex app-server exited (${code ?? "no-code"} ${signal ?? ""})`,
          this.lastStderr,
          this.profile
        )
      );
      this.emit("status", "closed");
    });
  }

  private startSsh2() {
    const { host, username, port } = parseSshTarget(
      this.profile.sshTarget,
      this.profile.port
    );
    const remoteCommand = `bash -lc ${shellQuote(buildRemoteCommand(this.profile))}`;

    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.rejectAll(error);
        this.emit("status", `error:${error.message}`);
      };

      client
        .on("ready", () => {
          client.exec(remoteCommand, (error, channel) => {
            if (error) {
              fail(error);
              return;
            }

            this.sshClient = client;
            this.setupSshChannel(channel);
            if (!settled) {
              settled = true;
              resolve();
            }
          });
        })
        .on("error", fail)
        .on("close", () => {
          this.rejectAll(new Error("SSH connection closed."));
          this.emit("status", "closed");
        })
        .connect({
          host,
          port,
          username,
          password: this.secrets.password,
          readyTimeout: 20_000,
          keepaliveInterval: 30_000,
          keepaliveCountMax: 3
        });
    });
  }

  private setupSshChannel(channel: ClientChannel) {
    this.rpcStream = channel;

    const rl = readline.createInterface({ input: channel });
    rl.on("line", (line) => this.handleLine(line));

    channel.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8");
      this.lastStderr += line;
      this.emit("stderr", line);
    });

    channel.on("close", () => {
      this.rejectAll(
        bridgeCloseError(
          "Remote codex app-server channel closed",
          this.lastStderr,
          this.profile
        )
      );
      this.emit("status", "closed");
    });
  }

  private canWriteRpc() {
    return Boolean(
      this.rpcStream &&
        !this.rpcStream.destroyed &&
        this.rpcStream.writable
    );
  }

  private writeRpc(message: unknown) {
    this.rpcStream?.write(`${JSON.stringify(message)}\n`);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    if (!this.canWriteRpc()) {
      return Promise.reject(new Error("Codex app-server is not connected."));
    }

    const id = this.nextId++;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writeRpc(message);
    });
  }

  private notify(method: string, params: unknown) {
    if (this.canWriteRpc()) {
      this.writeRpc({ method, params });
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
      | { threadId?: string; turnId?: string; turn?: { id?: string } }
      | undefined;

    if (message.method === "turn/started" && params?.threadId) {
      this.activeThreadId = params.threadId;
    }
    if (message.method === "turn/started" && params?.turn?.id) {
      this.activeTurnId = params.turn.id;
    }
    if (message.method === "turn/completed") {
      const completedTurnId = params?.turn?.id ?? params?.turnId;
      if (!completedTurnId || completedTurnId === this.activeTurnId) {
        this.activeTurnId = undefined;
      }
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
