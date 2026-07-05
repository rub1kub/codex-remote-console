import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AppPreferences,
  CodexProfile,
  ProfileInput,
  ThreadMetadata
} from "./types";

type Store = {
  profiles: CodexProfile[];
  preferences: AppPreferences;
  threadMetadata: Record<string, ThreadMetadata>;
};

const defaultUpdateCommand =
  "CODEX_NON_INTERACTIVE=1 codex update || npm install -g @openai/codex@latest";

const defaultPreferences: AppPreferences = {
  theme: "system",
  interfaceStyle: "native",
  reasoningLevel: "very-high",
  responseSpeed: "standard",
  animations: true,
  compactMode: false,
  autoCheckUpdates: true,
  autoRefreshHistory: true,
  enterToSend: true,
  showDiagnostics: false,
  historyLimit: 80,
  defaultUpdateCommand
};

const interfaceStyles = ["native", "session-first", "calm-terminal"] as const;
const reasoningLevels = ["low", "medium", "high", "very-high"] as const;
const responseSpeeds = ["standard", "fast"] as const;

const dataDir =
  process.env.CODEX_REMOTE_CONSOLE_HOME ??
  path.join(os.homedir(), ".codex-remote-console");
const storePath = path.join(dataDir, "profiles.json");

const now = () => new Date().toISOString();

async function readStore(): Promise<Store> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return {
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      preferences: normalizePreferences(parsed.preferences),
      threadMetadata:
        parsed.threadMetadata && typeof parsed.threadMetadata === "object"
          ? parsed.threadMetadata
          : {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { profiles: [], preferences: defaultPreferences, threadMetadata: {} };
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

function normalizePreferences(input?: Partial<AppPreferences>): AppPreferences {
  const historyLimit = Number(input?.historyLimit);
  const interfaceStyle = input?.interfaceStyle;
  return {
    ...defaultPreferences,
    ...input,
    theme: ["system", "light", "dark"].includes(input?.theme ?? "")
      ? input!.theme!
      : defaultPreferences.theme,
    interfaceStyle: interfaceStyles.includes(interfaceStyle as AppPreferences["interfaceStyle"])
      ? interfaceStyle as AppPreferences["interfaceStyle"]
      : defaultPreferences.interfaceStyle,
    reasoningLevel: reasoningLevels.includes(input?.reasoningLevel as AppPreferences["reasoningLevel"])
      ? input!.reasoningLevel!
      : defaultPreferences.reasoningLevel,
    responseSpeed: responseSpeeds.includes(input?.responseSpeed as AppPreferences["responseSpeed"])
      ? input!.responseSpeed!
      : defaultPreferences.responseSpeed,
    animations:
      typeof input?.animations === "boolean"
        ? input.animations
        : defaultPreferences.animations,
    compactMode:
      typeof input?.compactMode === "boolean"
        ? input.compactMode
        : defaultPreferences.compactMode,
    autoCheckUpdates:
      typeof input?.autoCheckUpdates === "boolean"
        ? input.autoCheckUpdates
        : defaultPreferences.autoCheckUpdates,
    autoRefreshHistory:
      typeof input?.autoRefreshHistory === "boolean"
        ? input.autoRefreshHistory
        : defaultPreferences.autoRefreshHistory,
    enterToSend:
      typeof input?.enterToSend === "boolean"
        ? input.enterToSend
        : defaultPreferences.enterToSend,
    showDiagnostics:
      typeof input?.showDiagnostics === "boolean"
        ? input.showDiagnostics
        : defaultPreferences.showDiagnostics,
    historyLimit:
      Number.isInteger(historyLimit) && historyLimit >= 10 && historyLimit <= 300
        ? historyLimit
        : defaultPreferences.historyLimit,
    defaultUpdateCommand:
      cleanText(input?.defaultUpdateCommand, defaultPreferences.defaultUpdateCommand) ||
      defaultPreferences.defaultUpdateCommand
  };
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
    updateCommand: cleanText(input.updateCommand, previous?.updateCommand ?? ""),
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
  await writeStore({ ...store, profiles: next });
  return next.length !== store.profiles.length;
}

export async function getPreferences() {
  return (await readStore()).preferences;
}

export async function savePreferences(input: Partial<AppPreferences>) {
  const store = await readStore();
  const preferences = normalizePreferences({ ...store.preferences, ...input });
  await writeStore({ ...store, preferences });
  return preferences;
}

export async function getThreadMetadata() {
  return (await readStore()).threadMetadata;
}

function normalizeThreadMetadata(
  current: ThreadMetadata,
  input: Partial<ThreadMetadata>
) {
  const next: ThreadMetadata = { ...current };

  if ("pinned" in input) {
    next.pinned = input.pinned === true ? true : undefined;
  }
  if ("hidden" in input) {
    next.hidden = input.hidden === true ? true : undefined;
  }
  if ("title" in input) {
    next.title = cleanText(input.title) || undefined;
  }

  return next;
}

function hasThreadMetadata(metadata: ThreadMetadata) {
  return Boolean(metadata.pinned || metadata.hidden || metadata.title);
}

export async function saveThreadMetadata(
  threadId: string,
  input: Partial<ThreadMetadata> = {}
) {
  const store = await readStore();
  const current = store.threadMetadata[threadId] ?? {};
  const next = normalizeThreadMetadata(current, input);

  const threadMetadata = { ...store.threadMetadata };
  if (hasThreadMetadata(next)) {
    threadMetadata[threadId] = next;
  } else {
    delete threadMetadata[threadId];
  }

  await writeStore({ ...store, threadMetadata });
  return threadMetadata[threadId] ?? {};
}

export { defaultPreferences, defaultUpdateCommand };
