#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const {
  AgentsRevisionConflictError,
  MAX_AGENTS_FILE_BYTES,
  MISSING_AGENTS_REVISION,
  commitProjectChanges,
  createProjectCheckpoint,
  getProjectGitStatus,
  listProjectBranches,
  pushCurrentBranch,
  readRootAgentsFile,
  stageProjectPaths,
  unstageProjectPaths,
  writeRootAgentsFile
} = require("../build/server/projectTools.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root });
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "codex-project-tools-"));
  const remoteRoot = await mkdtemp(path.join(tmpdir(), "codex-project-tools-remote-"));
  try {
    await git(root, "init", "-b", "main");
    await git(remoteRoot, "init", "--bare");
    await git(root, "config", "user.name", "Project Tools Test");
    await git(root, "config", "user.email", "project-tools@example.invalid");

    const profile = {
      id: "project-tools-test",
      name: "project-tools-test",
      mode: "local",
      sshTarget: "",
      projectPath: root,
      codexBin: "codex",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      createdAt: "",
      updatedAt: ""
    };

    await writeFile(path.join(root, "file with spaces.txt"), "first\n");
    let status = await getProjectGitStatus(profile, {});
    assert(status.branch.head === "main", "status misses current branch");
    assert(status.branch.ahead === 0 && status.branch.behind === 0, "status has invalid tracking counts");
    assert(status.files.some((file) => file.path === "file with spaces.txt" && file.kind === "untracked"), "status misses untracked file");

    status = await stageProjectPaths(profile, {}, ["file with spaces.txt"]);
    assert(status.files.some((file) => file.path === "file with spaces.txt" && file.staged), "stage did not update index status");

    status = await unstageProjectPaths(profile, {}, ["file with spaces.txt"]);
    assert(status.files.some((file) => file.path === "file with spaces.txt" && file.kind === "untracked"), "unstage did not restore untracked status");

    await stageProjectPaths(profile, {}, ["file with spaces.txt"]);
    const commit = await commitProjectChanges(profile, {}, "Initial project's tools test");
    assert(/^[0-9a-f]{40,64}$/.test(commit.commit), "commit returned an invalid id");
    assert(commit.status.files.length === 0, "working tree is dirty after commit");

    const branches = await listProjectBranches(profile, {});
    assert(branches.some((branch) => branch.name === "main" && branch.current), "branch list misses current branch");

    await git(root, "remote", "add", "origin", remoteRoot);
    const push = await pushCurrentBranch(profile, {});
    assert(push.branch === "main" && push.remote === "origin", "push used the wrong branch or remote");
    const pushedHead = (await git(remoteRoot, "rev-parse", "refs/heads/main")).stdout.trim();
    assert(pushedHead === commit.commit, "push did not update the current branch");
    await writeFile(path.join(root, "file with spaces.txt"), "second\n");
    await stageProjectPaths(profile, {}, ["file with spaces.txt"]);
    const localCommit = await commitProjectChanges(profile, {}, "Local commit after push");
    assert(localCommit.status.branch.upstream === "origin/main", "status misses upstream branch");
    assert(localCommit.status.branch.ahead === 1 && localCommit.status.branch.behind === 0, "status has wrong ahead/behind counts");

    await writeFile(path.join(root, "file with spaces.txt"), "checkpoint content\n");
    await writeFile(path.join(root, "checkpoint-new.txt"), "new at checkpoint\n");
    const beforeCheckpoint = await getProjectGitStatus(profile, {});
    const checkpoint = await createProjectCheckpoint(profile, {}, "Project tools checkpoint");
    assert(/^[0-9a-f]{40,64}$/.test(checkpoint.commit), "checkpoint returned an invalid commit");
    assert(checkpoint.ref.startsWith("refs/codex-remote/checkpoints/"), "checkpoint used an unexpected ref");
    assert(checkpoint.dirtyFiles === 2, "checkpoint returned the wrong dirty file count");
    const checkpointRef = (await git(root, "rev-parse", checkpoint.ref)).stdout.trim();
    assert(checkpointRef === checkpoint.commit, "checkpoint ref does not resolve to the snapshot commit");
    const trackedAtCheckpoint = (await git(root, "show", `${checkpoint.commit}:file with spaces.txt`)).stdout;
    const untrackedAtCheckpoint = (await git(root, "show", `${checkpoint.commit}:checkpoint-new.txt`)).stdout;
    assert(trackedAtCheckpoint === "checkpoint content\n", "checkpoint misses tracked changes");
    assert(untrackedAtCheckpoint === "new at checkpoint\n", "checkpoint misses untracked files");
    const afterCheckpoint = await getProjectGitStatus(profile, {});
    assert(JSON.stringify(afterCheckpoint.files) === JSON.stringify(beforeCheckpoint.files), "checkpoint changed the real Git index or worktree");
    await git(root, "restore", "file with spaces.txt");
    await rm(path.join(root, "checkpoint-new.txt"));

    const missingAgents = await readRootAgentsFile(profile, {});
    assert(!missingAgents.exists, "missing AGENTS.md was reported as existing");
    assert(missingAgents.revision === MISSING_AGENTS_REVISION, "missing AGENTS.md has wrong revision");

    const agentsContent = "# Repository instructions\n\nRun focused tests; don't run everything.\n";
    const writtenAgents = await writeRootAgentsFile(
      profile,
      {},
      agentsContent,
      missingAgents.revision
    );
    assert(writtenAgents.content === agentsContent, "AGENTS.md write changed content");
    assert(writtenAgents.revision.startsWith("sha256:"), "AGENTS.md write misses revision");

    const readAgents = await readRootAgentsFile(profile, {});
    assert(readAgents.content === agentsContent, "AGENTS.md read changed content");
    assert(readAgents.revision === writtenAgents.revision, "AGENTS.md revision is unstable");

    let conflict = null;
    try {
      await writeRootAgentsFile(profile, {}, "stale write\n", MISSING_AGENTS_REVISION);
    } catch (error) {
      conflict = error;
    }
    assert(conflict instanceof AgentsRevisionConflictError, "stale AGENTS.md write did not report a revision conflict");
    assert(conflict.currentRevision === writtenAgents.revision, "revision conflict returned the wrong current revision");

    const afterConflict = await readRootAgentsFile(profile, {});
    assert(afterConflict.content === agentsContent, "revision conflict modified AGENTS.md");

    const maximumAgentsContent = "'".repeat(MAX_AGENTS_FILE_BYTES);
    const maximumAgents = await writeRootAgentsFile(
      profile,
      {},
      maximumAgentsContent,
      readAgents.revision
    );
    assert(maximumAgents.size === MAX_AGENTS_FILE_BYTES, "128 KiB AGENTS.md write has wrong size");
    assert(maximumAgents.content === maximumAgentsContent, "128 KiB AGENTS.md write changed content");

    let unsafePathBlocked = false;
    try {
      await stageProjectPaths(profile, {}, ["../outside.txt"]);
    } catch {
      unsafePathBlocked = true;
    }
    assert(unsafePathBlocked, "project path traversal was not blocked");

    let oversizedAgentsBlocked = false;
    try {
      await writeRootAgentsFile(profile, {}, "x".repeat(MAX_AGENTS_FILE_BYTES + 1), maximumAgents.revision);
    } catch {
      oversizedAgentsBlocked = true;
    }
    assert(oversizedAgentsBlocked, "oversized AGENTS.md write was not blocked");

    await git(root, "mv", "file with spaces.txt", "renamed file.txt");
    const renameStatus = await getProjectGitStatus(profile, {});
    assert(renameStatus.files.some((file) =>
      file.kind === "renamed" &&
      file.path === "renamed file.txt" &&
      file.originalPath === "file with spaces.txt"
    ), "status did not parse a staged rename");

    console.log("project tools tests: ok");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
