import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "ssh2";

import type {
  AppPreferences,
  CodexProfile,
  ConnectionSecrets,
  DirectoryListInput,
  DirectoryEntry,
  DirectoryListing,
  FileSearchResult,
  ProjectDiff,
  ProjectHealth
} from "./types";

export type CommandResult = {
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

async function pathExists(value: string) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
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
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<DirectoryEntry> => {
        const entryPath = path.join(currentPath, entry.name);
        return {
          name: entry.name,
          path: entryPath,
          isGit: await pathExists(path.join(entryPath, ".git")),
          hasPackageJson: await pathExists(path.join(entryPath, "package.json"))
        };
      })
  );
  return {
    currentPath,
    parentPath: parentOf(currentPath, "local"),
    entries: directories.sort((left, right) => left.name.localeCompare(right.name))
  };
}

const directoryListCommand = [
  'CURRENT="$(pwd -P)"',
  'printf "cwd=%s\\n" "$CURRENT"',
  'for entry in "$CURRENT"/* "$CURRENT"/.[!.]* "$CURRENT"/..?*; do [ -d "$entry" ] || continue; name="${entry##*/}"; if [ "$name" = "." ] || [ "$name" = ".." ]; then continue; fi; git=0; pkg=0; [ -d "$entry/.git" ] && git=1; [ -f "$entry/package.json" ] && pkg=1; printf "dir=%s\\t%s\\t%s\\n" "$name" "$git" "$pkg"; done | LC_ALL=C sort'
].join("; ");

function parseRemoteDirectoryListing(stdout: string): DirectoryListing {
  let currentPath = "";
  const entries: DirectoryEntry[] = [];

  stdout.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("cwd=")) {
      currentPath = line.slice(4);
    } else if (line.startsWith("dir=")) {
      const [name, git, pkg] = line.slice(4).split("\t");
      if (name) {
        entries.push({
          name,
          path: joinRemotePath(currentPath, name),
          isGit: git === "1",
          hasPackageJson: pkg === "1"
        });
      }
    }
  });

  if (!currentPath) {
    throw new Error("Сервер не вернул текущую папку.");
  }

  return {
    currentPath,
    parentPath: parentOf(currentPath, "ssh"),
    entries
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

function validateProjectCommand(command: string) {
  const clean = command.trim();
  if (!clean) {
    throw new Error("Команда пустая.");
  }
  if (clean.length > 4000) {
    throw new Error("Команда слишком длинная.");
  }
  if (clean.includes("\0")) {
    throw new Error("Команда содержит недопустимый символ.");
  }
  return clean;
}

function parseSections(stdout: string) {
  const sections: Array<{ title: string; body: string }> = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("__CODEX_REMOTE_SECTION__ ")) {
      if (current) {
        sections.push({ title: current.title, body: current.lines.join("\n").trim() });
      }
      current = {
        title: line.replace("__CODEX_REMOTE_SECTION__ ", "").trim(),
        lines: []
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    sections.push({ title: current.title, body: current.lines.join("\n").trim() });
  }

  return sections;
}

function sectionBody(sections: Array<{ title: string; body: string }>, title: string) {
  return sections.find((section) => section.title === title)?.body.trim() ?? "";
}

const projectHealthCommand = [
  "set +e",
  'section(){ printf "\\n__CODEX_REMOTE_SECTION__ %s\\n" "$1"; }',
  "section cwd; pwd",
  'section git; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git status --short; else printf "not a git repository\\n"; fi',
  'section package; if [ -f package.json ]; then node -e \'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));console.log("name="+(p.name||""));console.log("scripts="+Object.keys(p.scripts||{}).join(","));\' 2>/dev/null || printf "package.json found\\n"; else printf "package.json not found\\n"; fi',
  'section package-manager; if [ -f pnpm-lock.yaml ]; then echo pnpm; elif [ -f yarn.lock ]; then echo yarn; elif [ -f bun.lockb ] || [ -f bun.lock ]; then echo bun; elif [ -f package-lock.json ]; then echo npm; else echo ""; fi',
  'section tools; for tool in git node npm pnpm yarn bun python python3 rg; do command -v "$tool" >/dev/null 2>&1 && printf "%s " "$tool"; done; printf "\\n"',
  'section checks; if [ -f package.json ]; then node -e \'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));const scripts=p.scripts||{};for(const key of Object.keys(scripts)){if(/^(test|lint|build|typecheck|check|ci)(:|$)/.test(key)) console.log(key)}\' 2>/dev/null; fi',
  'section logs; find . -maxdepth 3 -type f \\( -name "*.log" -o -name "npm-debug.log*" -o -name "yarn-error.log*" \\) -not -path "./node_modules/*" -not -path "./.git/*" 2>/dev/null | head -5'
].join("; ");

export async function inspectProjectHealth(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<ProjectHealth> {
  const result = await runProfileCommand(profile, secrets, projectHealthCommand);
  const sections = parseSections(result.stdout);
  const gitBody = sectionBody(sections, "git");
  const packageBody = sectionBody(sections, "package");
  const scriptsLine = packageBody
    .split(/\r?\n/)
    .find((line) => line.startsWith("scripts="));
  const scripts = scriptsLine
    ? scriptsLine.replace(/^scripts=/, "").split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const checksBody = sectionBody(sections, "checks");
  const dirtyFiles = gitBody && !/not a git repository/i.test(gitBody)
    ? gitBody.split(/\r?\n/).filter(Boolean).length
    : 0;

  return {
    cwd: sectionBody(sections, "cwd") || profile.projectPath,
    isGit: Boolean(gitBody) && !/not a git repository/i.test(gitBody),
    dirtyFiles,
    packageJson: Boolean(packageBody) && !/package\.json not found/i.test(packageBody),
    packageManager: sectionBody(sections, "package-manager") || "не найден",
    scripts,
    availableChecks: checksBody.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    sections,
    command: projectHealthCommand,
    exitCode: result.exitCode
  };
}

export async function readProjectDiff(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  files: string[] = []
): Promise<ProjectDiff> {
  const cleanFiles = files
    .map((file) => cleanText(file))
    .filter(Boolean)
    .slice(0, 30);
  const fileArgs = cleanFiles.length > 0
    ? ` -- ${cleanFiles.map(shellQuote).join(" ")}`
    : "";
  const command = [
    "set +e",
    'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf "__CODEX_REMOTE_SECTION__ status\\nnot a git repository\\n__CODEX_REMOTE_SECTION__ diff\\n"; exit 0; fi',
    'printf "__CODEX_REMOTE_SECTION__ status\\n"',
    "git status --short",
    'printf "__CODEX_REMOTE_SECTION__ diff\\n"',
    `git diff --no-ext-diff --minimal${fileArgs}`,
    `git diff --cached --no-ext-diff --minimal${fileArgs}`
  ].join("; ");
  const result = await runProfileCommand(profile, secrets, command);
  const sections = parseSections(result.stdout);

  return {
    status: sectionBody(sections, "status"),
    diff: sectionBody(sections, "diff"),
    command,
    exitCode: result.exitCode
  };
}

export async function searchProjectFiles(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  query: string
): Promise<FileSearchResult[]> {
  const cleanQuery = cleanText(query).toLowerCase();
  if (!cleanQuery) return [];

  const command = [
    "set +e",
    "if command -v rg >/dev/null 2>&1; then",
    "rg --files --hidden -g '!.git' -g '!node_modules' -g '!dist' -g '!build' 2>/dev/null;",
    "else",
    "find . -path './.git' -prune -o -path './node_modules' -prune -o -path './dist' -prune -o -path './build' -prune -o -type f -print 2>/dev/null | sed 's#^./##';",
    "fi"
  ].join(" ");
  const result = await runProfileCommand(profile, secrets, command);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => file.toLowerCase().includes(cleanQuery))
    .slice(0, 30)
    .map((file) => ({ path: file, label: path.posix.basename(file) }));
}

export async function runProjectQuickCommand(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  command: string
) {
  return runProfileCommand(profile, secrets, validateProjectCommand(command));
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

export async function preflightCodexCli(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  preferences: AppPreferences
): Promise<CodexCliStatus> {
  const codexBin = shellQuotePath(profile.codexBin || "codex");
  const command = [
    "set +e",
    `CODEX_PATH="$(command -v ${codexBin} 2>/dev/null)"`,
    `INSTALLED_RAW="$(${codexBin} --version 2>/dev/null)"`,
    'INSTALLED="$(printf "%s" "$INSTALLED_RAW" | awk \'{print $NF}\')"',
    'printf "installed=%s\\n" "$INSTALLED"',
    'printf "path=%s\\n" "$CODEX_PATH"',
    'if [ -z "$CODEX_PATH" ] && [ -z "$INSTALLED" ]; then exit 127; fi'
  ].join("; ");

  const result = await runProfileCommand(profile, secrets, command);
  if (result.exitCode !== 0 && !result.stdout.includes("installed=")) {
    throw new Error(result.stderr.trim() || "Не удалось проверить Codex CLI.");
  }

  const parsed = parseKeyValue(result.stdout);
  const installed = parsed.installed ?? "";
  const cliPath = parsed.path ?? "";
  const missing = !installed && !cliPath;
  const installCommand = getCodexInstallCommand(profile, preferences);

  return {
    installed,
    latest: "",
    path: cliPath,
    missing,
    updateAvailable: false,
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
