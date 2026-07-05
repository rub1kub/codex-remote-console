import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CodexProfile, ProfileInput } from "./types";

type Store = {
  profiles: CodexProfile[];
};

const dataDir =
  process.env.CODEX_REMOTE_CONSOLE_HOME ??
  path.join(os.homedir(), ".codex-remote-console");
const storePath = path.join(dataDir, "profiles.json");

const now = () => new Date().toISOString();

async function readStore(): Promise<Store> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Store;
    return { profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { profiles: [] };
    }
    throw error;
  }
}

async function writeStore(store: Store) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
}

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function cleanPort(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH port must be an integer between 1 and 65535.");
  }
  return port;
}

function validateTarget(target: string) {
  if (/[\r\n\t ]/.test(target)) {
    throw new Error("SSH target must be one OpenSSH target, for example devbox or user@host.");
  }
}

function normalizeProfile(input: ProfileInput, previous?: CodexProfile): CodexProfile {
  const mode = input.mode ?? previous?.mode ?? "ssh";
  const sshTarget = cleanText(input.sshTarget, previous?.sshTarget ?? "");
  const projectPath = cleanText(input.projectPath, previous?.projectPath ?? "");

  if (mode === "ssh" && !sshTarget) {
    throw new Error("SSH target is required.");
  }
  if (sshTarget) validateTarget(sshTarget);
  if (!projectPath) {
    throw new Error("Project path is required.");
  }

  const timestamp = now();
  return {
    id: previous?.id ?? randomUUID(),
    name:
      cleanText(input.name, previous?.name) ||
      (mode === "local" ? "Local Codex" : sshTarget),
    mode,
    sshTarget,
    port: cleanPort(input.port ?? previous?.port),
    identityFile: cleanText(input.identityFile, previous?.identityFile),
    projectPath,
    codexBin: cleanText(input.codexBin, previous?.codexBin ?? "codex") || "codex",
    model: cleanText(input.model, previous?.model),
    approvalPolicy:
      input.approvalPolicy ?? previous?.approvalPolicy ?? "never",
    sandboxMode:
      input.sandboxMode ?? previous?.sandboxMode ?? "danger-full-access",
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

export async function listProfiles() {
  return (await readStore()).profiles;
}

export async function getProfile(id: string) {
  return (await readStore()).profiles.find((profile) => profile.id === id);
}

export async function saveProfile(input: ProfileInput, id?: string) {
  const store = await readStore();
  const index = id
    ? store.profiles.findIndex((profile) => profile.id === id)
    : -1;
  const profile = normalizeProfile(input, index >= 0 ? store.profiles[index] : undefined);

  if (index >= 0) {
    store.profiles[index] = profile;
  } else {
    store.profiles.unshift(profile);
  }

  await writeStore(store);
  return profile;
}

export async function deleteProfile(id: string) {
  const store = await readStore();
  const next = store.profiles.filter((profile) => profile.id !== id);
  await writeStore({ profiles: next });
  return next.length !== store.profiles.length;
}

