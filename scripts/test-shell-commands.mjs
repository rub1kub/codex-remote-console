#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const {
  checkCodexCli,
  inspectProjectHealth,
  listProjectFiles,
  preflightCodexCli,
  readProjectDiff,
  readProjectFile,
  searchProjectFiles
} = require("../build/server/remoteExec.js");
const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function git(root, ...args) {
  await execFileAsync("git", args, { cwd: root });
}

async function assertRejected(run, message) {
  let blocked = false;
  try {
    await run();
  } catch {
    blocked = true;
  }
  assert(blocked, message);
}

async function verifyProjectCommands(profile, canonicalRoot, label) {
  const listing = await listProjectFiles(profile, {}, ".");
  assert(listing.entries.some((entry) => entry.path === "src" && entry.kind === "directory"), `${label}: root listing misses src directory`);
  assert(listing.entries.some((entry) => entry.path === "package.json" && entry.kind === "file"), `${label}: root listing misses package.json`);
  assert(!listing.entries.some((entry) => entry.name.startsWith("outside-")), `${label}: root listing exposes outside symlink`);

  const nested = await listProjectFiles(profile, {}, "src");
  assert(nested.currentPath === "src", `${label}: nested listing returns non-canonical project path`);
  assert(nested.entries.some((entry) => entry.path === "src/index.js"), `${label}: nested listing misses src/index.js`);

  const file = await readProjectFile(profile, {}, "src/index.js");
  assert(file.path === "src/index.js", `${label}: file preview returns wrong path`);
  assert(file.content.includes("console.log"), `${label}: file preview misses content`);
  assert(!file.binary, `${label}: text file marked as binary`);

  const matches = await searchProjectFiles(profile, {}, "untracked");
  assert(matches.some((match) => match.path === "notes/untracked.txt"), `${label}: file search misses untracked file`);
  const outsideMatches = await searchProjectFiles(profile, {}, "outside");
  assert(outsideMatches.length === 0, `${label}: file search exposes outside symlink`);

  const diff = await readProjectDiff(profile, {});
  assert(diff.exitCode === 0, `${label}: diff command failed`);
  assert(diff.status.includes("M  staged.txt"), `${label}: status misses staged file`);
  assert(diff.status.includes(" M tracked-unstaged.txt"), `${label}: status misses unstaged file`);
  assert(diff.status.includes("renamed-old.txt -> renamed-new.txt"), `${label}: status misses renamed file`);
  assert(diff.status.includes("?? notes/"), `${label}: status misses untracked file`);
  assert(diff.diff.includes("diff --git a/staged.txt b/staged.txt"), `${label}: diff misses staged changes`);
  assert(diff.diff.includes("diff --git a/tracked-unstaged.txt b/tracked-unstaged.txt"), `${label}: diff misses unstaged changes`);
  assert(diff.diff.includes("rename from renamed-old.txt"), `${label}: diff misses staged rename`);

  const selectedDiff = await readProjectDiff(profile, {}, ["staged.txt", "tracked-unstaged.txt"]);
  assert(selectedDiff.diff.includes("staged change"), `${label}: selected diff misses staged file`);
  assert(selectedDiff.diff.includes("unstaged change"), `${label}: selected diff misses unstaged file`);

  const health = await inspectProjectHealth(profile, {});
  assert(health.cwd === canonicalRoot, `${label}: health cwd is not the canonical project root`);
  assert(health.isGit, `${label}: health does not detect git repository`);
  assert(health.dirtyFiles >= 4, `${label}: health undercounts dirty files`);
  assert(health.diagnostics.some((item) => item.id === "project-dir" && item.status === "ok"), `${label}: health misses project-dir ok`);
  assert(health.diagnostics.some((item) => item.id === "git" && item.status === "ok"), `${label}: health misses git ok`);
  assert(health.packageJson, `${label}: health misses package.json`);
  assert(health.scripts.includes("test") && health.scripts.includes("build"), `${label}: health misses package scripts`);

  for (const unsafePath of ["..", "../package.json", "/etc/passwd", "outside-file.txt"]) {
    await assertRejected(
      () => readProjectFile(profile, {}, unsafePath),
      `${label}: unsafe file path was not blocked: ${unsafePath}`
    );
  }
  await assertRejected(
    () => listProjectFiles(profile, {}, "outside-dir"),
    `${label}: outside directory symlink was not blocked`
  );
  for (const unsafePath of ["../staged.txt", "/etc/passwd"]) {
    await assertRejected(
      () => readProjectDiff(profile, {}, [unsafePath]),
      `${label}: unsafe diff path was not blocked: ${unsafePath}`
    );
  }
  const outsideDiff = await readProjectDiff(profile, {}, ["outside-file.txt"]);
  assert(outsideDiff.exitCode !== 0, `${label}: outside symlink diff path was not blocked`);
  const magicDiff = await readProjectDiff(profile, {}, [":(top)**"]);
  assert(!magicDiff.diff, `${label}: git pathspec magic was interpreted`);
}

async function main() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-remote-shell-"));
  const originalPath = process.env.PATH;
  try {
    const root = path.join(fixtureRoot, "project");
    const projectLink = path.join(fixtureRoot, "project-link");
    const outside = path.join(fixtureRoot, "outside");
    const fakeBin = path.join(fixtureRoot, "bin");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(outside);
    await mkdir(fakeBin);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "codex-remote-shell-test",
      scripts: {
        test: "node src/index.js",
        build: "node src/index.js"
      }
    }, null, 2));
    await writeFile(path.join(root, "src", "index.js"), "console.log('ok')\n");
    await writeFile(path.join(root, "staged.txt"), "committed staged content\n");
    await writeFile(path.join(root, "tracked-unstaged.txt"), "committed unstaged content\n");
    await writeFile(path.join(root, "renamed-old.txt"), "rename content\n");

    await git(root, "init", "--quiet");
    await git(root, "config", "user.name", "Shell Test");
    await git(root, "config", "user.email", "shell-test@example.invalid");
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "fixture baseline");

    await writeFile(path.join(root, "staged.txt"), "committed staged content\nstaged change\n");
    await git(root, "add", "staged.txt");
    await git(root, "mv", "renamed-old.txt", "renamed-new.txt");
    await writeFile(path.join(root, "tracked-unstaged.txt"), "committed unstaged content\nunstaged change\n");
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "untracked.txt"), "untracked content\n");

    await writeFile(path.join(outside, "secret.txt"), "must not be exposed\n");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "outside-file.txt"));
    await symlink(outside, path.join(root, "outside-dir"));
    await symlink(root, projectLink);

    const fakeSsh = path.join(fakeBin, "ssh");
    await writeFile(fakeSsh, "#!/usr/bin/env bash\nremote_command=\"${!#}\"\nexec bash -lc \"$remote_command\"\n");
    await chmod(fakeSsh, 0o755);
    const healthyCodex = path.join(fakeBin, "codex-healthy");
    await writeFile(healthyCodex, "#!/usr/bin/env bash\necho 'codex-cli 0.144.1'\n");
    await chmod(healthyCodex, 0o755);
    const brokenCodex = path.join(fakeBin, "codex-broken");
    await writeFile(brokenCodex, "#!/usr/bin/env bash\necho 'Error: Missing optional dependency @openai/codex-linux-x64' >&2\nexit 1\n");
    await chmod(brokenCodex, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;

    const canonicalRoot = await realpath(root);

    const baseProfile = {
      id: "shell-test",
      name: "shell-test",
      sshTarget: "",
      projectPath: projectLink,
      codexBin: "codex",
      approvalPolicy: "never",
      sandboxMode: "read-only",
      createdAt: "",
      updatedAt: ""
    };
    await verifyProjectCommands({ ...baseProfile, mode: "local" }, canonicalRoot, "local");
    await verifyProjectCommands({ ...baseProfile, mode: "ssh", sshTarget: "fixture-host" }, canonicalRoot, "ssh");

    const preferences = { defaultUpdateCommand: "repair-codex" };
    const healthyStatus = await preflightCodexCli(
      { ...baseProfile, mode: "local", codexBin: healthyCodex },
      {},
      preferences
    );
    assert(!healthyStatus.missing && !healthyStatus.broken, "healthy Codex was not accepted");
    assert(healthyStatus.installed === "0.144.1", "healthy Codex version was not parsed");

    const brokenStatus = await checkCodexCli(
      { ...baseProfile, mode: "local", codexBin: brokenCodex },
      {},
      preferences
    );
    assert(!brokenStatus.missing && brokenStatus.broken, "broken Codex was not detected");
    assert(brokenStatus.message?.includes("повреждена"), "broken Codex misses repair guidance");

    const missingStatus = await preflightCodexCli(
      { ...baseProfile, mode: "local", codexBin: path.join(fakeBin, "codex-missing") },
      {},
      preferences
    );
    assert(missingStatus.missing && !missingStatus.broken, "missing Codex was not detected");

    console.log("shell command tests: ok");
  } finally {
    process.env.PATH = originalPath;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
