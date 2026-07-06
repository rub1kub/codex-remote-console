import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "ssh2";

import type {
  AppPreferences,
  CodexProfile,
  ConnectionSecrets,
  DirectoryListInput,
  DirectoryListing
} from "./types";

type CommandResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

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
};

const COMMAND_TIMEOUT_MS = 180_000;

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

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map((part) => Number(part) || 0);
  const rightParts = right.split(".").map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function parseKeyValue(stdout: string) {
  return stdout.split(/\r?\n/).reduce<Record<string, string>>((acc, line) => {
    const index = line.indexOf("=");
    if (index > 0) {
      acc[line.slice(0, index)] = line.slice(index + 1);
    }
    return acc;
  }, {});
}

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function getCodexInstallCommand(
  profile: CodexProfile,
  preferences: AppPreferences
) {
  return profile.updateCommand || preferences.defaultUpdateCommand;
}

function codexMissingMessage(profile: CodexProfile) {
  const target =
    profile.mode === "local"
      ? "на этом компьютере"
      : `на сервере ${profile.sshTarget}`;
  return `Codex CLI не найден ${target}. Откройте Настройки -> Codex, нажмите "Установить" и подключитесь к проекту снова.`;
}

function validateTarget(target: string) {
  if (/[\r\n\t ]/.test(target)) {
    throw new Error("Укажите один SSH сервер, например user@host.");
  }
}

function normalizeBrowsePath(value: unknown, mode: CodexProfile["mode"]) {
  const cleaned = cleanText(value);
  if (cleaned) return cleaned;
  return mode === "local" ? os.homedir() : "~";
}

function parentOf(currentPath: string, mode: CodexProfile["mode"]) {
  const parent = mode === "local"
    ? path.dirname(currentPath)
    : path.posix.dirname(currentPath);
  return parent && parent !== currentPath ? parent : undefined;
}

function joinRemotePath(parent: string, name: string) {
  if (parent === "/") return `/${name}`;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

function buildDirectoryProbeProfile(input: DirectoryListInput): CodexProfile {
  const mode = input.mode === "local" ? "local" : "ssh";
  const sshTarget = cleanText(input.sshTarget);
  if (mode === "ssh") {
    if (!sshTarget) throw new Error("Укажите сервер.");
    validateTarget(sshTarget);
  }

  return {
    id: "directory-browser",
    name: "directory-browser",
    mode,
    sshTarget,
    port: input.port,
    identityFile: cleanText(input.identityFile),
    projectPath: normalizeBrowsePath(input.path ?? input.projectPath, mode),
    codexBin: "codex",
    approvalPolicy: "never",
    sandboxMode: "read-only",
    createdAt: "",
    updatedAt: ""
  };
}

async function listLocalDirectories(
  profile: CodexProfile
): Promise<DirectoryListing> {
  const currentPath = expandLocalPath(profile.projectPath);
  const entries = await readdir(currentPath, { withFileTypes: true });
  return {
    currentPath,
    parentPath: parentOf(currentPath, "local"),
    entries: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(currentPath, entry.name)
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

const directoryListCommand = [
  'CURRENT="$(pwd -P)"',
  'printf "cwd=%s\\n" "$CURRENT"',
  'for entry in "$CURRENT"/* "$CURRENT"/.[!.]* "$CURRENT"/..?*; do [ -d "$entry" ] || continue; name="${entry##*/}"; if [ "$name" = "." ] || [ "$name" = ".." ]; then continue; fi; printf "dir=%s\\n" "$name"; done | LC_ALL=C sort'
].join("; ");

function parseRemoteDirectoryListing(stdout: string): DirectoryListing {
  let currentPath = "";
  const names: string[] = [];

  stdout.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("cwd=")) {
      currentPath = line.slice(4);
    } else if (line.startsWith("dir=")) {
      const name = line.slice(4);
      if (name) names.push(name);
    }
  });

  if (!currentPath) {
    throw new Error("Сервер не вернул текущую папку.");
  }

  return {
    currentPath,
    parentPath: parentOf(currentPath, "ssh"),
    entries: names.map((name) => ({
      name,
      path: joinRemotePath(currentPath, name)
    }))
  };
}

function runLocalCommand(profile: CodexProfile, command: string) {
  const isWindows = process.platform === "win32";
  const child = isWindows
    ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
        cwd: expandLocalPath(profile.projectPath),
        windowsHide: true
      })
    : spawn("bash", ["-lc", command], {
        cwd: expandLocalPath(profile.projectPath)
      });

  return collectChild(child, command);
}

function collectChild(
  child: ReturnType<typeof spawn>,
  command: string,
  timeoutMs = COMMAND_TIMEOUT_MS
) {
  return new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ command, stdout, stderr, exitCode });
    });
  });
}

function runSystemSshCommand(profile: CodexProfile, command: string) {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3"
  ];

  if (profile.port) args.push("-p", String(profile.port));
  if (profile.identityFile) args.push("-i", expandLocalPath(profile.identityFile));

  const remoteCommand = [
    `cd ${shellQuotePath(profile.projectPath)}`,
    command
  ].join(" && ");
  args.push(profile.sshTarget, `bash -lc ${shellQuote(remoteCommand)}`);

  return collectChild(spawn("ssh", args, { cwd: process.cwd() }), command);
}

function runSsh2Command(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  command: string
) {
  const { host, username, port } = parseSshTarget(
    profile.sshTarget,
    profile.port
  );
  const remoteCommand = [
    `cd ${shellQuotePath(profile.projectPath)}`,
    command
  ].join(" && ");

  return new Promise<CommandResult>((resolve, reject) => {
    const client = new Client();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timer);

    client
      .on("ready", () => {
        client.exec(`bash -lc ${shellQuote(remoteCommand)}`, (error, stream) => {
          if (error) {
            cleanup();
            reject(error);
            return;
          }
          stream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          stream.on("close", (exitCode: number | null) => {
            cleanup();
            client.end();
            resolve({ command, stdout, stderr, exitCode });
          });
        });
      })
      .on("error", (error) => {
        cleanup();
        reject(error);
      })
      .connect({
        host,
        port,
        username,
        password: secrets.password,
        readyTimeout: 20_000,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3
      });
  });
}

export function runProfileCommand(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  command: string
) {
  if (profile.mode === "local") {
    return runLocalCommand(profile, command);
  }
  if (secrets.password) {
    return runSsh2Command(profile, secrets, command);
  }
  return runSystemSshCommand(profile, command);
}

export async function listDirectories(
  input: DirectoryListInput,
  secrets: ConnectionSecrets = {}
): Promise<DirectoryListing> {
  const profile = buildDirectoryProbeProfile(input);
  if (profile.mode === "local") {
    return listLocalDirectories(profile);
  }

  const result = await runProfileCommand(profile, secrets, directoryListCommand);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Не удалось открыть ${profile.projectPath}.`);
  }
  return parseRemoteDirectoryListing(result.stdout);
}

export async function checkCodexCli(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  preferences: AppPreferences
): Promise<CodexCliStatus> {
  const codexBin = shellQuotePath(profile.codexBin || "codex");
  const command = [
    "set +e",
    `INSTALLED_RAW="$(${codexBin} --version 2>/dev/null)"`,
    'INSTALLED="$(printf "%s" "$INSTALLED_RAW" | awk \'{print $NF}\')"',
    "LATEST=\"$(npm view @openai/codex version 2>/dev/null)\"",
    `CODEX_PATH="$(command -v ${codexBin} 2>/dev/null)"`,
    'printf "installed=%s\\n" "$INSTALLED"',
    'printf "latest=%s\\n" "$LATEST"',
    'printf "path=%s\\n" "$CODEX_PATH"'
  ].join("; ");

  const result = await runProfileCommand(profile, secrets, command);
  if (result.exitCode !== 0 && !result.stdout.includes("installed=")) {
    throw new Error(result.stderr.trim() || "Не удалось проверить Codex CLI.");
  }
  const parsed = parseKeyValue(result.stdout);
  const installed = parsed.installed ?? "";
  const latest = parsed.latest ?? "";
  const cliPath = parsed.path ?? "";
  const missing = !installed && !cliPath;
  const installCommand = getCodexInstallCommand(profile, preferences);

  return {
    installed,
    latest,
    path: cliPath,
    missing,
    updateAvailable:
      Boolean(installed && latest) && compareVersions(installed, latest) < 0,
    command: installCommand,
    installCommand,
    message: missing ? codexMissingMessage(profile) : undefined,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function updateCodexCli(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  preferences: AppPreferences
) {
  const command = getCodexInstallCommand(profile, preferences);
  const result = await runProfileCommand(profile, secrets, command);
  const status = await checkCodexCli(profile, secrets, preferences);
  const updateError =
    result.exitCode !== 0
      ? (result.stderr.trim() || result.stdout.trim())
      : "";

  return {
    ...status,
    message: updateError
      ? `Команда установки/обновления Codex завершилась ошибкой: ${updateError}`
      : status.message,
    updateExitCode: result.exitCode,
    updateStdout: result.stdout,
    updateStderr: result.stderr
  };
}
