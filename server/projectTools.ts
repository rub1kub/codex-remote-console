import { createHash, randomUUID } from "node:crypto";

import { runProfileCommand, type CommandResult } from "./remoteExec";
import type { CodexProfile, ConnectionSecrets } from "./types";

const MAX_PATHS = 100;
const MAX_PATH_BYTES = 4096;
const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024;
export const MAX_AGENTS_FILE_BYTES = 128 * 1024;
export const MISSING_AGENTS_REVISION = "missing";

export type GitStatusEntryKind =
  | "ordinary"
  | "renamed"
  | "unmerged"
  | "untracked"
  | "ignored";

export type GitStatusEntry = {
  path: string;
  originalPath?: string;
  kind: GitStatusEntryKind;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
};

export type GitBranchStatus = {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type ProjectGitStatus = {
  branch: GitBranchStatus;
  files: GitStatusEntry[];
};

export type GitBranch = {
  name: string;
  fullName: string;
  kind: "local" | "remote";
  current: boolean;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type GitCommitResult = {
  commit: string;
  status: ProjectGitStatus;
  stdout: string;
  stderr: string;
};

export type GitPushResult = {
  branch: string;
  remote: string;
  remoteBranch: string;
  setUpstream: boolean;
  stdout: string;
  stderr: string;
};

export type ProjectCheckpoint = {
  id: string;
  ref: string;
  commit: string;
  baseCommit: string | null;
  branch: string | null;
  dirtyFiles: number;
  createdAt: string;
  label: string;
};

export type RootAgentsFile = {
  exists: boolean;
  content: string;
  size: number;
  revision: string;
};

export type RuntimeProcess = {
  pid: number;
  parentPid: number;
  user: string;
  elapsed: string;
  cpuPercent: number;
  memoryPercent: number;
  command: string;
};

export type RuntimeLogFile = {
  path: string;
  size: number;
  modifiedAt: number;
};

export type RuntimeService = {
  id: string;
  name: string;
  status: string;
  detail?: string;
};

export type RuntimeServiceProvider = {
  available: boolean;
  exitCode: number | null;
  services: RuntimeService[];
  raw: string;
};

export type ProjectRuntimeSnapshot = {
  capturedAt: string;
  processes: RuntimeProcess[];
  logs: RuntimeLogFile[];
  services: {
    systemctl: RuntimeServiceProvider;
    pm2: RuntimeServiceProvider;
    docker: RuntimeServiceProvider;
  };
};

export class ProjectToolCommandError extends Error {
  readonly result: CommandResult;

  constructor(message: string, result: CommandResult) {
    super(message);
    this.name = "ProjectToolCommandError";
    this.result = result;
  }
}

export class AgentsRevisionConflictError extends Error {
  readonly expectedRevision: string;
  readonly currentRevision: string;

  constructor(expectedRevision: string, currentRevision: string) {
    super("AGENTS.md changed since it was read.");
    this.name = "AgentsRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandError(result: CommandResult, fallback: string) {
  const raw = result.stderr.trim() || result.stdout.trim();
  const cleaned = raw
    .split(/\r?\n/)
    .filter((line) => !/^\*\* (WARNING: connection|This session|The server may need)/.test(line.trim()))
    .join("\n")
    .trim();
  const message = /(?:bash: )?git: command not found/i.test(cleaned)
    ? "Git не установлен на сервере или недоступен в PATH."
    : cleaned || fallback;
  return new ProjectToolCommandError(
    message,
    result
  );
}

async function runChecked(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  command: string,
  fallback: string
) {
  const result = await runProfileCommand(profile, secrets, command);
  if (result.exitCode !== 0) throw commandError(result, fallback);
  return result;
}

function validateProjectPath(value: string) {
  if (typeof value !== "string") throw new Error("Project path must be a string.");
  const clean = value.replace(/^\.\/+/, "");
  if (!clean) throw new Error("Project path is empty.");
  if (Buffer.byteLength(clean, "utf8") > MAX_PATH_BYTES) {
    throw new Error("Project path is too long.");
  }
  if (
    clean.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(clean) ||
    clean.startsWith("\\\\") ||
    clean.includes("\\") ||
    clean.split("/").includes("..") ||
    /[\0-\x1f\x7f]/.test(clean)
  ) {
    throw new Error(`Project path must stay inside the project: ${value}`);
  }
  return clean;
}

function validateProjectPaths(paths: readonly string[]) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("At least one project path is required.");
  }
  if (paths.length > MAX_PATHS) {
    throw new Error(`At most ${MAX_PATHS} project paths are allowed.`);
  }
  return [...new Set(paths.map(validateProjectPath))];
}

function validateCommitMessage(message: string) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Commit message is empty.");
  }
  if (Buffer.byteLength(message, "utf8") > MAX_COMMIT_MESSAGE_BYTES) {
    throw new Error("Commit message is too long.");
  }
  if (/\0|\r|[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) {
    throw new Error("Commit message contains an unsupported control character.");
  }
  return message;
}

function validateCheckpointLabel(label: string) {
  const clean = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "";
  if (!clean) return "Codex Remote task";
  if (Buffer.byteLength(clean, "utf8") > 500 || /[\0\x01-\x1f\x7f]/.test(clean)) {
    throw new Error("Checkpoint label is invalid.");
  }
  return clean;
}

function validateBranchName(branch: string) {
  if (
    typeof branch !== "string" ||
    !branch ||
    Buffer.byteLength(branch, "utf8") > 255 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch === "@" ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")) ||
    /[\0-\x20\x7f~^:?*\[\\]/.test(branch)
  ) {
    throw new Error(`Invalid Git branch name: ${branch}`);
  }
  return branch;
}

function validateRemoteName(remote: string) {
  if (
    typeof remote !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) ||
    remote.endsWith("/") ||
    remote.includes("..") ||
    remote.includes("//")
  ) {
    throw new Error(`Invalid Git remote name: ${remote}`);
  }
  return remote;
}

function statusFlags(indexStatus: string, worktreeStatus: string) {
  return {
    staged: indexStatus !== "." && indexStatus !== "?" && indexStatus !== "!",
    unstaged:
      worktreeStatus !== "." || indexStatus === "?" || indexStatus === "!"
  };
}

function parseGitStatus(stdout: string): ProjectGitStatus {
  const branch: GitBranchStatus = {
    head: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0
  };
  const files: GitStatusEntry[] = [];
  const records = stdout.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice(13);
      branch.oid = oid === "(initial)" ? null : oid;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      branch.head = record.slice(14) || null;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      branch.upstream = record.slice(18) || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      continue;
    }

    const ordinary = record.match(
      /^1 ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/s
    );
    if (ordinary) {
      const [indexStatus, worktreeStatus] = ordinary[1].split("");
      files.push({
        path: ordinary[8],
        kind: "ordinary",
        indexStatus,
        worktreeStatus,
        ...statusFlags(indexStatus, worktreeStatus)
      });
      continue;
    }

    const renamed = record.match(
      /^2 ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/s
    );
    if (renamed) {
      const [indexStatus, worktreeStatus] = renamed[1].split("");
      files.push({
        path: renamed[9],
        originalPath: records[index + 1] || undefined,
        kind: "renamed",
        indexStatus,
        worktreeStatus,
        ...statusFlags(indexStatus, worktreeStatus)
      });
      index += 1;
      continue;
    }

    const unmerged = record.match(
      /^u ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.*)$/s
    );
    if (unmerged) {
      const [indexStatus, worktreeStatus] = unmerged[1].split("");
      files.push({
        path: unmerged[10],
        kind: "unmerged",
        indexStatus,
        worktreeStatus,
        ...statusFlags(indexStatus, worktreeStatus)
      });
      continue;
    }

    if (record.startsWith("? ") || record.startsWith("! ")) {
      const ignored = record.startsWith("! ");
      files.push({
        path: record.slice(2),
        kind: ignored ? "ignored" : "untracked",
        indexStatus: ignored ? "!" : "?",
        worktreeStatus: ignored ? "!" : "?",
        staged: false,
        unstaged: !ignored
      });
    }
  }

  return { branch, files };
}

export async function getProjectGitStatus(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<ProjectGitStatus> {
  const result = await runChecked(
    profile,
    secrets,
    "git status --porcelain=v2 --branch -z --untracked-files=all",
    "Unable to read Git status."
  );
  return parseGitStatus(result.stdout);
}

export async function stageProjectPaths(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  paths: readonly string[]
) {
  const cleanPaths = validateProjectPaths(paths);
  await runChecked(
    profile,
    secrets,
    `git add -- ${cleanPaths.map(shellQuote).join(" ")}`,
    "Unable to stage project paths."
  );
  return getProjectGitStatus(profile, secrets);
}

export async function unstageProjectPaths(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  paths: readonly string[]
) {
  const cleanPaths = validateProjectPaths(paths);
  const pathArgs = cleanPaths.map(shellQuote).join(" ");
  const command = [
    "if git rev-parse --verify HEAD >/dev/null 2>&1; then",
    `git restore --staged -- ${pathArgs}`,
    "else",
    `git update-index --force-remove -- ${pathArgs}`,
    "fi"
  ].join("\n");
  await runChecked(profile, secrets, command, "Unable to unstage project paths.");
  return getProjectGitStatus(profile, secrets);
}

export async function commitProjectChanges(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  message: string
): Promise<GitCommitResult> {
  const cleanMessage = validateCommitMessage(message);
  const commitResult = await runChecked(
    profile,
    secrets,
    `git commit -m ${shellQuote(cleanMessage)}`,
    "Unable to create Git commit."
  );
  const headResult = await runChecked(
    profile,
    secrets,
    "git rev-parse --verify HEAD",
    "Unable to resolve the new Git commit."
  );
  const commit = headResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error("Git returned an invalid commit id.");
  }
  return {
    commit,
    status: await getProjectGitStatus(profile, secrets),
    stdout: commitResult.stdout,
    stderr: commitResult.stderr
  };
}

function parseTracking(value: string) {
  const ahead = value.match(/ahead (\d+)/)?.[1];
  const behind = value.match(/behind (\d+)/)?.[1];
  return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
}

export async function listProjectBranches(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<GitBranch[]> {
  const format = [
    "%(refname)",
    "%(refname:short)",
    "%(objectname)",
    "%(HEAD)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(symref)"
  ].join("%09");
  const result = await runChecked(
    profile,
    secrets,
    `git for-each-ref --sort=-committerdate --format=${shellQuote(format)} refs/heads refs/remotes`,
    "Unable to list Git branches."
  );

  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const [fullName, name, head, marker, upstream, tracking, symref] = line.split("\t");
      if (
        !fullName ||
        !name ||
        !head ||
        symref ||
        (!fullName.startsWith("refs/heads/") && !fullName.startsWith("refs/remotes/"))
      ) {
        return [];
      }
      validateBranchName(
        fullName.startsWith("refs/heads/")
          ? fullName.slice("refs/heads/".length)
          : fullName.slice("refs/remotes/".length)
      );
      return [{
        name,
        fullName,
        kind: fullName.startsWith("refs/heads/") ? "local" as const : "remote" as const,
        current: marker === "*",
        head,
        upstream: upstream || null,
        ...parseTracking(tracking || "")
      }];
    });
}

async function resolvePushTarget(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  branch: string
) {
  const remoteKey = `branch.${branch}.remote`;
  const mergeKey = `branch.${branch}.merge`;
  const remoteResult = await runProfileCommand(
    profile,
    secrets,
    `git config --get ${shellQuote(remoteKey)}`
  );
  const mergeResult = await runProfileCommand(
    profile,
    secrets,
    `git config --get ${shellQuote(mergeKey)}`
  );

  if (remoteResult.exitCode === 0 && mergeResult.exitCode === 0) {
    const remote = validateRemoteName(remoteResult.stdout.trim());
    const mergeRef = mergeResult.stdout.trim();
    if (!mergeRef.startsWith("refs/heads/")) {
      throw new Error(`Unsupported upstream ref: ${mergeRef}`);
    }
    return {
      remote,
      remoteBranch: validateBranchName(mergeRef.slice("refs/heads/".length)),
      setUpstream: false
    };
  }

  const remotesResult = await runChecked(
    profile,
    secrets,
    "git remote",
    "Unable to list Git remotes."
  );
  const remotes = remotesResult.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(validateRemoteName);
  const remote = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : null;
  if (!remote) {
    throw new Error("The current branch has no upstream and no unambiguous Git remote.");
  }
  return { remote, remoteBranch: branch, setUpstream: true };
}

export async function pushCurrentBranch(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<GitPushResult> {
  const status = await getProjectGitStatus(profile, secrets);
  if (!status.branch.head || status.branch.head === "(detached)") {
    throw new Error("Cannot push while Git HEAD is detached.");
  }
  const branch = validateBranchName(status.branch.head);
  const target = await resolvePushTarget(profile, secrets, branch);
  const refspec = `HEAD:refs/heads/${target.remoteBranch}`;
  const command = [
    "git push --porcelain",
    target.setUpstream ? "--set-upstream" : "",
    shellQuote(target.remote),
    shellQuote(refspec)
  ].filter(Boolean).join(" ");
  const result = await runChecked(
    profile,
    secrets,
    command,
    "Unable to push the current Git branch."
  );
  return {
    branch,
    remote: target.remote,
    remoteBranch: target.remoteBranch,
    setUpstream: target.setUpstream,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function createProjectCheckpoint(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  label: string
): Promise<ProjectCheckpoint> {
  const cleanLabel = validateCheckpointLabel(label);
  const id = `${Date.now()}-${randomUUID()}`;
  const ref = `refs/codex-remote/checkpoints/${id}`;
  const command = [
    "set -e",
    "tmp_index=$(mktemp)",
    "rm -f \"$tmp_index\"",
    "trap 'rm -f \"$tmp_index\"' EXIT",
    "export GIT_INDEX_FILE=$tmp_index",
    "base=$(git rev-parse --verify HEAD 2>/dev/null || true)",
    "branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)",
    "if [ -n \"$base\" ]; then git read-tree \"$base\"; else git read-tree --empty; fi",
    "git add -A -- .",
    "tree=$(git write-tree)",
    `export GIT_AUTHOR_NAME=${shellQuote("Codex Remote")}`,
    `export GIT_AUTHOR_EMAIL=${shellQuote("checkpoint@codex-remote.invalid")}`,
    "export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME",
    "export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL",
    "if [ -n \"$base\" ]; then",
    `  checkpoint=$(git commit-tree \"$tree\" -p \"$base\" -m ${shellQuote(cleanLabel)})`,
    "else",
    `  checkpoint=$(git commit-tree \"$tree\" -m ${shellQuote(cleanLabel)})`,
    "fi",
    `git update-ref ${shellQuote(ref)} \"$checkpoint\"`,
    "dirty=$(git --no-optional-locks status --porcelain=v1 --untracked-files=all | wc -l | tr -d ' ')",
    "printf 'commit=%s\\nbase=%s\\nbranch=%s\\ndirty=%s\\n' \"$checkpoint\" \"$base\" \"$branch\" \"${dirty:-0}\""
  ].join("\n");
  const result = await runChecked(
    profile,
    secrets,
    command,
    "Unable to create a project checkpoint."
  );
  const values = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
      .filter(([key]) => Boolean(key))
  );
  const commit = values.commit || "";
  const baseCommit = values.base || null;
  if (!/^[0-9a-f]{40,64}$/i.test(commit) || (baseCommit && !/^[0-9a-f]{40,64}$/i.test(baseCommit))) {
    throw new Error("Git returned an invalid checkpoint id.");
  }
  return {
    id,
    ref,
    commit,
    baseCommit,
    branch: values.branch || null,
    dirtyFiles: Number(values.dirty) || 0,
    createdAt: new Date().toISOString(),
    label: cleanLabel
  };
}

const nodeSha256Script = [
  "const fs=require('node:fs')",
  "const crypto=require('node:crypto')",
  "const hash=crypto.createHash('sha256')",
  "hash.update(fs.readFileSync(process.argv[1]))",
  "process.stdout.write(hash.digest('hex'))"
].join(";");

const nodeBase64DecodeScript = [
  "const fs=require('node:fs')",
  "fs.writeFileSync(process.argv[2],Buffer.from(process.argv[1],'base64'))"
].join(";");

const fileRevisionFunction = [
  "file_revision() {",
  "  target=$1",
  "  hash=''",
  "  if command -v sha256sum >/dev/null 2>&1; then",
  "    hash=$(sha256sum \"$target\" 2>/dev/null | awk '{print $1}')",
  "  elif command -v shasum >/dev/null 2>&1; then",
  "    hash=$(shasum -a 256 \"$target\" 2>/dev/null | awk '{print $1}')",
  "  elif command -v openssl >/dev/null 2>&1; then",
  "    hash=$(openssl dgst -sha256 \"$target\" 2>/dev/null | sed 's/^.*= *//')",
  "  elif command -v node >/dev/null 2>&1; then",
  `    hash=$(node -e ${shellQuote(nodeSha256Script)} \"$target\" 2>/dev/null)`,
  "  fi",
  "  case \"$hash\" in",
  "    ''|*[!0-9a-fA-F]*) return 1 ;;",
  "  esac",
  "  if [ \"${#hash}\" -ne 64 ]; then return 1; fi",
  "  printf 'sha256:%s' \"$hash\" | tr 'A-F' 'a-f'",
  "}"
].join("\n");

function parseAgentsOutput(stdout: string): RootAgentsFile {
  const prefix = "__PROJECT_TOOLS_AGENTS__\n";
  const contentMarker = "\n__CONTENT__\n";
  if (!stdout.startsWith(prefix)) throw new Error("Invalid AGENTS.md response.");
  const markerIndex = stdout.indexOf(contentMarker, prefix.length);
  if (markerIndex < 0) throw new Error("Invalid AGENTS.md content response.");
  const metadata = Object.fromEntries(
    stdout.slice(prefix.length, markerIndex)
      .split(/\r?\n/)
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
      .filter(([key]) => Boolean(key))
  );
  const content = stdout.slice(markerIndex + contentMarker.length);
  const exists = metadata.exists === "1";
  const size = Number(metadata.size) || 0;
  const revision = metadata.revision || MISSING_AGENTS_REVISION;
  if (!exists) {
    return { exists: false, content: "", size: 0, revision: MISSING_AGENTS_REVISION };
  }
  if (Buffer.byteLength(content, "utf8") !== size) {
    throw new Error("AGENTS.md changed while it was being read.");
  }
  const localRevision = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  if (revision !== localRevision) {
    throw new Error("AGENTS.md changed while it was being read.");
  }
  return { exists, content, size, revision };
}

export async function readRootAgentsFile(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<RootAgentsFile> {
  const command = [
    "set +e",
    fileRevisionFunction,
    "target=./AGENTS.md",
    "if [ -L \"$target\" ]; then printf 'AGENTS.md symlinks are not supported.\\n' >&2; exit 2; fi",
    `if [ ! -e \"$target\" ]; then printf '__PROJECT_TOOLS_AGENTS__\\nexists=0\\nsize=0\\nrevision=${MISSING_AGENTS_REVISION}\\n__CONTENT__\\n'; exit 0; fi`,
    "if [ ! -f \"$target\" ]; then printf 'AGENTS.md is not a regular file.\\n' >&2; exit 2; fi",
    "size=$(wc -c < \"$target\" 2>/dev/null | tr -d ' ')",
    `if [ -z \"$size\" ] || [ \"$size\" -gt ${MAX_AGENTS_FILE_BYTES} ]; then printf 'AGENTS.md exceeds the 128 KiB limit.\\n' >&2; exit 4; fi`,
    "revision=$(file_revision \"$target\") || { printf 'No SHA-256 tool is available.\\n' >&2; exit 5; }",
    "printf '__PROJECT_TOOLS_AGENTS__\\nexists=1\\nsize=%s\\nrevision=%s\\n__CONTENT__\\n' \"$size\" \"$revision\"",
    "cat \"$target\""
  ].join("\n");
  const result = await runChecked(
    profile,
    secrets,
    command,
    "Unable to read the root AGENTS.md file."
  );
  return parseAgentsOutput(result.stdout);
}

function validateAgentsRevision(revision: string) {
  if (revision === MISSING_AGENTS_REVISION || /^sha256:[0-9a-f]{64}$/.test(revision)) {
    return revision;
  }
  throw new Error("Invalid AGENTS.md revision.");
}

export async function writeRootAgentsFile(
  profile: CodexProfile,
  secrets: ConnectionSecrets,
  content: string,
  expectedRevision: string
): Promise<RootAgentsFile> {
  if (typeof content !== "string") throw new Error("AGENTS.md content must be a string.");
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_AGENTS_FILE_BYTES) throw new Error("AGENTS.md exceeds the 128 KiB limit.");
  if (content.includes("\0")) throw new Error("AGENTS.md contains a NUL byte.");
  const expected = validateAgentsRevision(expectedRevision);
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  const command = [
    "set +e",
    fileRevisionFunction,
    "target=./AGENTS.md",
    "lock=./.AGENTS.md.codex-lock",
    "tmp=''",
    "mode=644",
    "if ! mkdir \"$lock\" 2>/dev/null; then printf 'AGENTS.md is already being updated.\\n' >&2; exit 5; fi",
    "cleanup() { [ -n \"$tmp\" ] && rm -f \"$tmp\"; rmdir \"$lock\" 2>/dev/null; }",
    "trap cleanup EXIT HUP INT TERM",
    "if [ -L \"$target\" ]; then printf 'AGENTS.md symlinks are not supported.\\n' >&2; exit 2; fi",
    "if [ -e \"$target\" ] && [ ! -f \"$target\" ]; then printf 'AGENTS.md is not a regular file.\\n' >&2; exit 2; fi",
    "if [ -e \"$target\" ]; then mode=$(stat -f '%Lp' \"$target\" 2>/dev/null || stat -c '%a' \"$target\" 2>/dev/null || printf 644); fi",
    "case \"$mode\" in [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;; *) mode=644 ;; esac",
    "if [ -e \"$target\" ]; then current=$(file_revision \"$target\") || { printf 'No SHA-256 tool is available.\\n' >&2; exit 6; }; else current=missing; fi",
    `if [ \"$current\" != ${shellQuote(expected)} ]; then printf 'conflict=%s\\n' \"$current\"; exit 3; fi`,
    "umask 077",
    "tmp=$(mktemp './.AGENTS.md.codex-tmp.XXXXXX') || { printf 'Unable to create AGENTS.md temporary file.\\n' >&2; exit 7; }",
    `encoded=${shellQuote(encodedContent)}`,
    "decoded=0",
    "if command -v base64 >/dev/null 2>&1; then",
    "  if printf '%s' \"$encoded\" | base64 --decode > \"$tmp\" 2>/dev/null; then decoded=1;",
    "  elif printf '%s' \"$encoded\" | base64 -D > \"$tmp\" 2>/dev/null; then decoded=1; fi",
    "fi",
    "if [ \"$decoded\" -eq 0 ] && command -v openssl >/dev/null 2>&1; then",
    "  if printf '%s' \"$encoded\" | openssl base64 -d -A > \"$tmp\" 2>/dev/null; then decoded=1; fi",
    "fi",
    "if [ \"$decoded\" -eq 0 ] && command -v node >/dev/null 2>&1; then",
    `  if node -e ${shellQuote(nodeBase64DecodeScript)} \"$encoded\" \"$tmp\" 2>/dev/null; then decoded=1; fi`,
    "fi",
    "if [ \"$decoded\" -ne 1 ]; then printf 'No base64 decoder is available.\\n' >&2; exit 7; fi",
    `written=$(wc -c < \"$tmp\" 2>/dev/null | tr -d ' '); if [ \"$written\" != ${shellQuote(String(size))} ]; then printf 'AGENTS.md write was incomplete.\\n' >&2; exit 7; fi`,
    "chmod \"$mode\" \"$tmp\" || exit 7",
    "mv -f \"$tmp\" \"$target\" || exit 7",
    "tmp=''",
    "revision=$(file_revision \"$target\") || exit 6",
    `printf '__PROJECT_TOOLS_AGENTS__\\nexists=1\\nsize=${size}\\nrevision=%s\\n__CONTENT__\\n' \"$revision\"`,
    "cat \"$target\""
  ].join("\n");
  const result = await runProfileCommand(profile, secrets, command);
  if (result.exitCode === 3) {
    const current = result.stdout.match(/^conflict=(.+)$/m)?.[1] || MISSING_AGENTS_REVISION;
    throw new AgentsRevisionConflictError(expected, current);
  }
  if (result.exitCode !== 0) {
    throw commandError(result, "Unable to write the root AGENTS.md file.");
  }
  return parseAgentsOutput(result.stdout);
}

function parseRuntimeSections(stdout: string) {
  const sections = new Map<string, string>();
  let name = "";
  let lines: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("__PROJECT_TOOLS_SECTION__ ")) {
      if (name) sections.set(name, lines.join("\n"));
      name = line.slice("__PROJECT_TOOLS_SECTION__ ".length);
      lines = [];
    } else if (name) {
      lines.push(line);
    }
  }
  if (name) sections.set(name, lines.join("\n"));
  return sections;
}

function parseProcesses(body: string, projectPath: string): RuntimeProcess[] {
  const normalizedProjectPath = projectPath.replace(/\/$/, "");
  return body.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      user: match[3],
      elapsed: match[4],
      cpuPercent: Number(match[5]) || 0,
      memoryPercent: Number(match[6]) || 0,
      command: match[7]
    }];
  }).sort((left, right) => {
    const leftProject = normalizedProjectPath && left.command.includes(normalizedProjectPath) ? 1 : 0;
    const rightProject = normalizedProjectPath && right.command.includes(normalizedProjectPath) ? 1 : 0;
    if (leftProject !== rightProject) return rightProject - leftProject;
    if (left.cpuPercent !== right.cpuPercent) return right.cpuPercent - left.cpuPercent;
    return right.memoryPercent - left.memoryPercent;
  }).slice(0, 60);
}

function parseLogs(body: string): RuntimeLogFile[] {
  return body.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^log=([^\t]+)\t(\d+)\t(\d+)$/);
    if (!match) return [];
    try {
      const filePath = Buffer.from(match[1], "base64").toString("utf8");
      if (!filePath || filePath.includes("\0")) return [];
      return [{ path: filePath, size: Number(match[2]), modifiedAt: Number(match[3]) }];
    } catch {
      return [];
    }
  });
}

function parseProvider(body: string, parseServices: (raw: string) => RuntimeService[]) {
  const available = body.startsWith("available=1\n") || body === "available=1";
  const withoutAvailability = body.replace(/^available=[01]\n?/, "");
  const exitMatch = withoutAvailability.match(/(?:^|\n)__PROJECT_TOOLS_EXIT__=(\d+)\s*$/);
  const raw = withoutAvailability
    .replace(/(?:^|\n)__PROJECT_TOOLS_EXIT__=\d+\s*$/, "")
    .trim();
  const exitCode = available ? Number(exitMatch?.[1] ?? 0) : null;
  return {
    available,
    exitCode,
    services: available && exitCode === 0 ? parseServices(raw) : [],
    raw
  } satisfies RuntimeServiceProvider;
}

function parseSystemctlServices(raw: string): RuntimeService[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\S+)\s+\S+\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) return [];
    return [{ id: match[1], name: match[4] || match[1], status: `${match[2]}/${match[3]}` }];
  });
}

function parsePm2Services(raw: string): RuntimeService[] {
  try {
    const values = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(values)) return [];
    return values.map((value) => {
      const environment = value.pm2_env && typeof value.pm2_env === "object"
        ? value.pm2_env as Record<string, unknown>
        : {};
      return {
        id: String(value.pm_id ?? value.name ?? ""),
        name: String(value.name ?? value.pm_id ?? "PM2 process"),
        status: String(environment.status ?? "unknown"),
        detail: value.pid ? `pid ${String(value.pid)}` : undefined
      };
    });
  } catch {
    return [];
  }
}

function parseDockerServices(raw: string): RuntimeService[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return [{
        id: String(value.ID ?? value.Id ?? ""),
        name: String(value.Names ?? value.Name ?? value.ID ?? "Docker container"),
        status: String(value.Status ?? value.State ?? "unknown"),
        detail: [value.Image, value.Ports].filter(Boolean).map(String).join(" | ") || undefined
      }];
    } catch {
      return [];
    }
  });
}

export async function inspectProjectRuntime(
  profile: CodexProfile,
  secrets: ConnectionSecrets
): Promise<ProjectRuntimeSnapshot> {
  const command = [
    "set +e",
    "export LC_ALL=C",
    "printf '__PROJECT_TOOLS_SECTION__ processes\\n'",
    "ps -eo pid=,ppid=,user=,etime=,pcpu=,pmem=,command= 2>/dev/null | head -n 100",
    "printf '__PROJECT_TOOLS_SECTION__ logs\\n'",
    "count=0",
    "while IFS= read -r -d '' file && [ \"$count\" -lt 30 ]; do",
    "  rel=${file#./}",
    "  encoded=$(printf '%s' \"$rel\" | base64 | tr -d '\\r\\n')",
    "  size=$(wc -c < \"$file\" 2>/dev/null | tr -d ' ')",
    "  modified=$(date -r \"$file\" +%s 2>/dev/null || stat -c %Y \"$file\" 2>/dev/null || printf 0)",
    "  printf 'log=%s\\t%s\\t%s\\n' \"$encoded\" \"${size:-0}\" \"${modified:-0}\"",
    "  count=$((count + 1))",
    "done < <(find . -maxdepth 4 -type f \\( -name '*.log' -o -name '*.log.*' -o -name 'npm-debug.log*' -o -name 'yarn-error.log*' -o -name 'pnpm-debug.log*' -o -name '*.out' -o -name '*.err' \\) -not -path './.git/*' -not -path './node_modules/*' -not -path './dist/*' -not -path './build/*' -not -path './release/*' -print0 2>/dev/null)",
    "printf '__PROJECT_TOOLS_SECTION__ systemctl\\n'",
    "if command -v systemctl >/dev/null 2>&1; then printf 'available=1\\n'; systemctl list-units --type=service --state=running --no-legend --no-pager --plain 2>&1; code=$?; printf '\\n__PROJECT_TOOLS_EXIT__=%s\\n' \"$code\"; else printf 'available=0\\n'; fi",
    "printf '__PROJECT_TOOLS_SECTION__ pm2\\n'",
    "if command -v pm2 >/dev/null 2>&1; then printf 'available=1\\n'; pm2 jlist 2>&1; code=$?; printf '\\n__PROJECT_TOOLS_EXIT__=%s\\n' \"$code\"; else printf 'available=0\\n'; fi",
    "printf '__PROJECT_TOOLS_SECTION__ docker\\n'",
    `if command -v docker >/dev/null 2>&1; then printf 'available=1\\n'; docker ps --no-trunc --format ${shellQuote("{{json .}}")} 2>&1; code=$?; printf '\\n__PROJECT_TOOLS_EXIT__=%s\\n' \"$code\"; else printf 'available=0\\n'; fi`
  ].join("\n");
  const result = await runChecked(
    profile,
    secrets,
    command,
    "Unable to inspect the project runtime."
  );
  const sections = parseRuntimeSections(result.stdout);
  return {
    capturedAt: new Date().toISOString(),
    processes: parseProcesses(sections.get("processes") || "", profile.projectPath),
    logs: parseLogs(sections.get("logs") || ""),
    services: {
      systemctl: parseProvider(sections.get("systemctl") || "available=0", parseSystemctlServices),
      pm2: parseProvider(sections.get("pm2") || "available=0", parsePm2Services),
      docker: parseProvider(sections.get("docker") || "available=0", parseDockerServices)
    }
  };
}
