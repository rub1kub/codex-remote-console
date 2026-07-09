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
  McpStatus,
  ProjectDiagnostic,
  ProjectDiff,
  ProjectFileEntry,
  ProjectFileContent,
  ProjectFileListing,
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

function cleanProjectRelativePath(value: unknown, fallback = ".") {
  const clean = cleanText(value, fallback).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!clean || clean === ".") return ".";
  if (clean.startsWith("/") || clean.split("/").includes("..") || clean.includes("\0")) {
    throw new Error("Path must stay inside the project.");
  }
  return clean;
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

const projectConfinementPrelude = [
  "project_realpath(){",
  '  local resolved target_dir target_name;',
  '  if command -v realpath >/dev/null 2>&1; then command realpath "$1"; return; fi;',
  '  if command -v readlink >/dev/null 2>&1; then resolved="$(readlink -f "$1" 2>/dev/null)" && [ -n "$resolved" ] && { printf "%s\\n" "$resolved"; return; }; fi;',
  '  if [ -d "$1" ]; then (cd -P -- "$1" 2>/dev/null && pwd -P); return; fi;',
  '  target_dir="$(dirname "$1")"; target_name="$(basename "$1")";',
  '  (cd -P -- "$target_dir" 2>/dev/null && [ ! -L "$target_name" ] && printf "%s/%s\\n" "$(pwd -P)" "$target_name");',
  "}",
  'PROJECT_ROOT="$(project_realpath . 2>/dev/null)"',
  'if [ -z "$PROJECT_ROOT" ] || [ ! -d "$PROJECT_ROOT" ]; then printf "project root unavailable\\n" >&2; exit 90; fi',
  "project_path_is_inside(){",
  '  [ "$PROJECT_ROOT" = "/" ] && return 0;',
  '  case "$1" in "$PROJECT_ROOT"|"$PROJECT_ROOT"/*) return 0;; *) return 1;; esac;',
  "}",
  "project_resolve_inside(){",
  '  local resolved;',
  '  resolved="$(project_realpath "$1" 2>/dev/null)" || return 1;',
  '  project_path_is_inside "$resolved" || return 1;',
  '  printf "%s\\n" "$resolved";',
  "}",
  "project_safe_file(){",
  '  local resolved;',
  '  resolved="$(project_resolve_inside "$1")" || return 1;',
  '  [ -f "$resolved" ] || return 1;',
  '  printf "%s\\n" "$resolved";',
  "}",
  'cd -P -- "$PROJECT_ROOT" || exit 90'
];

function projectHealthCommand(profile: CodexProfile) {
  const codexBin = shellQuotePath(profile.codexBin || "codex");
  return [
    "set +e",
    ...projectConfinementPrelude,
    'section(){ printf "\\n__CODEX_REMOTE_SECTION__ %s\\n" "$1"; }',
    'diag(){ printf "diag=%s\\t%s\\t%s\\t%s\\n" "$1" "$2" "$3" "$4"; }',
    "section cwd",
    'printf "%s\\n" "$PROJECT_ROOT"',
    "section diagnostics",
    'diag ssh ok "SSH" "команда на проекте выполнена"',
    'if [ -d "$PROJECT_ROOT" ]; then diag project-dir ok "Папка проекта" "$PROJECT_ROOT"; else diag project-dir fail "Папка проекта" "не найдена"; fi',
    'if [ -r . ]; then diag read ok "Чтение" "папка доступна для чтения"; else diag read fail "Чтение" "нет прав на чтение"; fi',
    'if [ -w . ]; then tmp=".codex-remote-write-test-$$"; if (: > "$tmp") 2>/dev/null; then rm -f "$tmp"; diag write ok "Запись" "write-test прошел"; else diag write warn "Запись" "папка помечена writable, но write-test не прошел"; fi; else diag write warn "Запись" "нет прав на запись"; fi',
    'ROOT_COUNT="$(find . -maxdepth 1 -mindepth 1 -not -path "./.git" 2>/dev/null | wc -l | tr -d " ")"; if [ "${ROOT_COUNT:-0}" -gt 0 ]; then diag file-tree ok "Файлы" "найдено ${ROOT_COUNT} элементов в корне"; else diag file-tree warn "Файлы" "корень проекта пуст или недоступен"; fi',
    `CODEX_PATH="$(command -v ${codexBin} 2>/dev/null)"`,
    `CODEX_VERSION="$(${codexBin} --version 2>/dev/null | head -1)"`,
    'if [ -n "$CODEX_PATH" ] || [ -n "$CODEX_VERSION" ]; then diag codex ok "Codex CLI" "${CODEX_VERSION:-найден} ${CODEX_PATH}"; else diag codex fail "Codex CLI" "не установлен или не в PATH"; fi',
    `if ${codexBin} app-server --help >/dev/null 2>&1; then diag app-server ok "App server" "команда app-server доступна"; else diag app-server warn "App server" "команда app-server недоступна или CLI старый"; fi`,
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then diag git ok "Git" "репозиторий найден"; else diag git warn "Git" "это не git-репозиторий"; fi',
    'PACKAGE_JSON="$(project_safe_file ./package.json 2>/dev/null)"',
    'if [ -n "$PACKAGE_JSON" ]; then diag package ok "package.json" "найден"; else diag package info "package.json" "не найден или ведет за пределы проекта"; fi',
    'section git',
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git status --short -- .; else printf "not a git repository\\n"; fi',
    'section package',
    'if [ -n "$PACKAGE_JSON" ]; then node -e \'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log("name="+(p.name||""));console.log("scripts="+Object.keys(p.scripts||{}).join(","));\' "$PACKAGE_JSON" 2>/dev/null || printf "package.json found\\n"; else printf "package.json not found\\n"; fi',
    'section package-manager',
    'if project_safe_file ./pnpm-lock.yaml >/dev/null; then echo pnpm; elif project_safe_file ./yarn.lock >/dev/null; then echo yarn; elif project_safe_file ./bun.lockb >/dev/null || project_safe_file ./bun.lock >/dev/null; then echo bun; elif project_safe_file ./package-lock.json >/dev/null; then echo npm; else echo ""; fi',
    'section tools',
    'for tool in git node npm pnpm yarn bun python python3 rg; do command -v "$tool" >/dev/null 2>&1 && printf "%s " "$tool"; done; printf "\\n"',
    'section checks',
    'if [ -n "$PACKAGE_JSON" ]; then node -e \'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const scripts=p.scripts||{};for(const key of Object.keys(scripts)){if(/^(test|lint|build|typecheck|check|ci)(:|$)/.test(key)) console.log(key)}\' "$PACKAGE_JSON" 2>/dev/null; fi',
    'section logs',
    'find . -maxdepth 3 -type f \\( -name "*.log" -o -name "npm-debug.log*" -o -name "yarn-error.log*" \\) -not -path "./node_modules/*" -not -path "./.git/*" 2>/dev/null | head -5'
  ].join("\n");
}

function parseProjectDiagnostics(body: string): ProjectDiagnostic[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("diag="))
    .map((line) => {
      const [id, status, label, detail] = line.slice(5).split("\t");
      const cleanStatus =
        status === "ok" || status === "warn" || status === "fail" || status === "info"
          ? status
          : "info";
      return {
        id: id || "check",
        status: cleanStatus,
        label: label || id || "Проверка",
        detail: detail || ""
      };
    });
}

export async function inspectProjectHealth(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<ProjectHealth> {
  const command = projectHealthCommand(profile);
  const result = await runProfileCommand(profile, secrets, command);
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
    diagnostics: parseProjectDiagnostics(sectionBody(sections, "diagnostics")),
    sections,
    command,
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
    .map((file) => cleanProjectRelativePath(file))
    .slice(0, 30);
  const fileArgs = cleanFiles.length > 0
    ? ` -- ${cleanFiles.map(shellQuote).join(" ")}`
    : " -- .";
  const validateFileArgs = cleanFiles.length > 0
    ? [
        `for TARGET in ${cleanFiles.map(shellQuote).join(" ")}; do`,
        '  if [ -e "./$TARGET" ] || [ -L "./$TARGET" ]; then project_resolve_inside "./$TARGET" >/dev/null || { printf "outside project\\n" >&2; exit 2; }; fi;',
        "done"
      ]
    : [];
  const command = [
    "set +e",
    ...projectConfinementPrelude,
    ...validateFileArgs,
    'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf "__CODEX_REMOTE_SECTION__ status\\nnot a git repository\\n__CODEX_REMOTE_SECTION__ diff\\n"; exit 0; fi',
    'printf "__CODEX_REMOTE_SECTION__ status\\n"',
    "git status --short -- .",
    'printf "__CODEX_REMOTE_SECTION__ diff\\n"',
    `git --literal-pathspecs diff --no-ext-diff --minimal${fileArgs}`,
    `git --literal-pathspecs diff --cached --no-ext-diff --minimal${fileArgs}`
  ].join("\n");
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
    ...projectConfinementPrelude,
    "if command -v rg >/dev/null 2>&1; then",
    "rg --files --hidden -g '!.git' -g '!node_modules' -g '!dist' -g '!build' 2>/dev/null;",
    "else",
    "find . -path './.git' -prune -o -path './node_modules' -prune -o -path './dist' -prune -o -path './build' -prune -o -type f -print 2>/dev/null | sed 's#^./##';",
    "fi | while IFS= read -r file; do",
    '  file="${file#./}"; [ -n "$file" ] || continue;',
    '  resolved="$(project_safe_file "./$file" 2>/dev/null)" || continue;',
    '  printf "%s\\n" "$file";',
    "done"
  ].join("\n");
  const result = await runProfileCommand(profile, secrets, command);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !/(^|\/)(__pycache__|node_modules|dist|build|venv|\.venv)(\/|$)/.test(file))
    .filter((file) => !file.endsWith(".pyc"))
    .filter((file) => file.toLowerCase().includes(cleanQuery))
    .slice(0, 30)
    .map((file) => ({ path: file, label: path.posix.basename(file) }));
}

function parentProjectPath(value: string) {
  if (!value || value === ".") return undefined;
  const parent = value.split("/").filter(Boolean).slice(0, -1).join("/");
  return parent || ".";
}

function parseProjectFileListing(stdout: string, requestedPath: string): ProjectFileListing {
  let currentPath = requestedPath === "." ? "" : requestedPath;
  const entries = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (line.startsWith("cwd=")) {
        currentPath = line.slice(4);
        return [];
      }
      if (!line.startsWith("entry=")) return [];
      const [kind, name, entryPath, size, modifiedAt, git, pkg] = line.slice(6).split("\t");
      if (!name || !entryPath || (kind !== "file" && kind !== "directory")) return [];
      const entry: ProjectFileEntry = {
        kind,
        name,
        path: entryPath,
        size: Number(size) || undefined,
        modifiedAt: Number(modifiedAt) || undefined,
        isGit: git === "1",
        hasPackageJson: pkg === "1"
      };
      return [entry];
    });

  return {
    currentPath,
    parentPath: parentProjectPath(currentPath || "."),
    entries: entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
  };
}

export async function listProjectFiles(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  directoryPath: string
): Promise<ProjectFileListing> {
  const relativePath = cleanProjectRelativePath(directoryPath);
  const command = [
    "set +e",
    ...projectConfinementPrelude,
    `REQUESTED=${shellQuote(relativePath)}`,
    'TARGET="./$REQUESTED"',
    'CURRENT="$(project_resolve_inside "$TARGET" 2>/dev/null)"',
    'if [ -z "$CURRENT" ] || [ ! -d "$CURRENT" ]; then printf "not a directory or outside project\\n" >&2; exit 2; fi',
    'cd -P -- "$CURRENT" || exit 2',
    'if [ "$PROJECT_ROOT" = "/" ]; then REL="${CURRENT#/}"; else REL="${CURRENT#$PROJECT_ROOT}"; REL="${REL#/}"; fi',
    'printf "cwd=%s\\n" "$REL"',
    'for entry in "$CURRENT"/* "$CURRENT"/.[!.]* "$CURRENT"/..?*; do',
    '  [ -e "$entry" ] || continue;',
    '  name="${entry##*/}"; if [ "$name" = "." ] || [ "$name" = ".." ]; then continue; fi;',
    '  entry_real="$(project_resolve_inside "$entry" 2>/dev/null)" || continue;',
    '  if [ "$PROJECT_ROOT" = "/" ]; then rel="${entry#/}"; else rel="${entry#$PROJECT_ROOT/}"; fi;',
    '  if [ -d "$entry_real" ]; then kind=directory; size=0; git=0; pkg=0; [ -d "$entry_real/.git" ] && git=1; project_safe_file "$entry_real/package.json" >/dev/null && pkg=1; else kind=file; size="$(wc -c < "$entry_real" 2>/dev/null | tr -d " ")"; git=0; pkg=0; fi;',
    '  mtime="$(date -r "$entry_real" +%s 2>/dev/null || stat -c %Y "$entry_real" 2>/dev/null || printf 0)";',
    '  printf "entry=%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$kind" "$name" "$rel" "${size:-0}" "${mtime:-0}" "$git" "$pkg";',
    "done"
  ].join("\n");
  const result = await runProfileCommand(profile, secrets, command);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Не удалось открыть папку проекта.");
  }
  return parseProjectFileListing(result.stdout, relativePath);
}

export async function readProjectFile(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  filePath: string
): Promise<ProjectFileContent> {
  const relativePath = cleanProjectRelativePath(filePath);
  const command = [
    "set +e",
    ...projectConfinementPrelude,
    `REQUESTED=${shellQuote(relativePath)}`,
    'TARGET="./$REQUESTED"',
    'TARGET_PATH="$(project_safe_file "$TARGET" 2>/dev/null)"',
    'if [ -z "$TARGET_PATH" ]; then printf "not a file or outside project\\n" >&2; exit 2; fi',
    'SIZE="$(wc -c < "$TARGET_PATH" 2>/dev/null | tr -d " ")";',
    'printf "__CODEX_REMOTE_SECTION__ meta\\n"',
    'printf "path=%s\\nsize=%s\\n" "$REQUESTED" "${SIZE:-0}"',
    'if ! LC_ALL=C grep -Iq . "$TARGET_PATH" 2>/dev/null && [ "${SIZE:-0}" != "0" ]; then printf "binary=1\\n__CODEX_REMOTE_SECTION__ content\\n"; exit 0; fi',
    'printf "binary=0\\ntruncated=%s\\n" "$([ "${SIZE:-0}" -gt 120000 ] && printf 1 || printf 0)"',
    'printf "__CODEX_REMOTE_SECTION__ content\\n"',
    'head -c 120000 "$TARGET_PATH"'
  ].join("\n");
  const result = await runProfileCommand(profile, secrets, command);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Не удалось прочитать файл.");
  }
  const sections = parseSections(result.stdout);
  const meta = parseKeyValue(sectionBody(sections, "meta"));
  const size = Number(meta.size) || 0;
  const binary = meta.binary === "1";
  const content = binary ? "" : sectionBody(sections, "content");
  return {
    path: meta.path || relativePath,
    content,
    size,
    binary,
    truncated: meta.truncated === "1" || content.length >= 120000
  };
}

function parseMcpList(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines
    .filter((line) => !/^name\s+/i.test(line) && !/^[-\s]+$/.test(line))
    .map((line) => {
      const [name, ...rest] = line.split(/\s{2,}|\t+/).filter(Boolean);
      return {
        name: name || line,
        status: rest.join(" · ") || undefined,
        raw: line
      };
    });
}

export async function inspectMcpServers(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<McpStatus> {
  const codexBin = shellQuotePath(profile.codexBin || "codex");
  const command = `${codexBin} mcp list`;
  const result = await runProfileCommand(profile, secrets, command);
  return {
    servers: parseMcpList(result.stdout),
    raw: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    command,
    exitCode: result.exitCode
  };
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
