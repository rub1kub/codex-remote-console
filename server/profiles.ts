import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const legacyDefaultUpdateCommand =
  "CODEX_NON_INTERACTIVE=1 codex update || npm install -g @openai/codex@latest";

const previousDefaultUpdateCommand =
  "(set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh) || npm install -g @openai/codex@latest";

const defaultUpdateCommand =
  "(set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh) || true; if ! codex --version >/dev/null 2>&1; then CODEX_VERSION=\"$(npm view @openai/codex version)\"; CODEX_OS=\"$(uname -s | tr '[:upper:]' '[:lower:]')\"; CODEX_ARCH=\"$(uname -m)\"; case \"$CODEX_ARCH\" in x86_64|amd64) CODEX_ARCH=x64 ;; aarch64|arm64) CODEX_ARCH=arm64 ;; *) echo \"Unsupported Codex architecture: $CODEX_ARCH\" >&2; exit 1 ;; esac; CODEX_PLATFORM=\"${CODEX_OS}-${CODEX_ARCH}\"; npm install -g \"@openai/codex@${CODEX_VERSION}\" \"@openai/codex-${CODEX_PLATFORM}@npm:@openai/codex@${CODEX_VERSION}-${CODEX_PLATFORM}\" --include=optional; fi; codex --version";

const defaultPreferences: AppPreferences = {
  theme: "system",
  accentColor: "",
  connectionColor: "",
  userMessageColor: "",
  interfaceStyle: "native",
  reasoningLevel: "very-high",
  responseSpeed: "standard",
  animations: true,
  compactMode: false,
  autoCheckUpdates: true,
  autoCheckAppUpdates: true,
  autoRefreshHistory: true,
  enterToSend: true,
  notifyOnCompletion: true,
  showDiagnostics: false,
  showTaskTimer: true,
  showTokenUsage: true,
  appUpdateChannel: "stable",
  historyLimit: 80,
  defaultUpdateCommand
};

const interfaceStyles = ["native", "session-first", "calm-terminal"] as const;
const reasoningLevels = ["low", "medium", "high", "very-high", "max", "ultra"] as const;
const responseSpeeds = ["standard", "fast"] as const;
const appUpdateChannels = ["stable", "preview"] as const;

const dataDir =
  process.env.CODEX_REMOTE_CONSOLE_HOME ??
  path.join(os.homedir(), ".codex-remote-console");
const storePath = path.join(dataDir, "profiles.json");
let storeMutationQueue: Promise<unknown> = Promise.resolve();

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
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  await rename(temporaryPath, storePath);
}

function mutateStore<T>(mutation: (store: Store) => T | Promise<T>) {
  const operation = storeMutationQueue.then(async () => {
    const store = await readStore();
    const result = await mutation(store);
    await writeStore(store);
    return result;
  });
  storeMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function cleanThemeColor(value: unknown) {
  if (typeof value !== "string") return "";
  const color = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : "";
}

function cleanStringList(value: unknown, fallback: string[] = []) {
  const source = Array.isArray(value) ? value : fallback;
  return source
    .map((item) => cleanText(item))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 20);
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
  const savedUpdateCommand = cleanText(
    input?.defaultUpdateCommand,
    defaultPreferences.defaultUpdateCommand
  );
  return {
    ...defaultPreferences,
    ...input,
    theme: ["system", "light", "dark"].includes(input?.theme ?? "")
      ? input!.theme!
      : defaultPreferences.theme,
    accentColor: cleanThemeColor(input?.accentColor),
    connectionColor: cleanThemeColor(input?.connectionColor),
    userMessageColor: cleanThemeColor(input?.userMessageColor),
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
    autoCheckAppUpdates:
      typeof input?.autoCheckAppUpdates === "boolean"
        ? input.autoCheckAppUpdates
        : defaultPreferences.autoCheckAppUpdates,
    autoRefreshHistory:
      typeof input?.autoRefreshHistory === "boolean"
        ? input.autoRefreshHistory
        : defaultPreferences.autoRefreshHistory,
    enterToSend:
      typeof input?.enterToSend === "boolean"
        ? input.enterToSend
        : defaultPreferences.enterToSend,
    notifyOnCompletion:
      typeof input?.notifyOnCompletion === "boolean"
        ? input.notifyOnCompletion
        : defaultPreferences.notifyOnCompletion,
    showDiagnostics:
      typeof input?.showDiagnostics === "boolean"
        ? input.showDiagnostics
        : defaultPreferences.showDiagnostics,
    showTaskTimer:
      typeof input?.showTaskTimer === "boolean"
        ? input.showTaskTimer
        : defaultPreferences.showTaskTimer,
    showTokenUsage:
      typeof input?.showTokenUsage === "boolean"
        ? input.showTokenUsage
        : defaultPreferences.showTokenUsage,
    appUpdateChannel: appUpdateChannels.includes(input?.appUpdateChannel as AppPreferences["appUpdateChannel"])
      ? input!.appUpdateChannel!
      : defaultPreferences.appUpdateChannel,
    historyLimit:
      Number.isInteger(historyLimit) && historyLimit >= 10 && historyLimit <= 300
        ? historyLimit
        : defaultPreferences.historyLimit,
    defaultUpdateCommand:
      !savedUpdateCommand ||
      savedUpdateCommand === legacyDefaultUpdateCommand ||
      savedUpdateCommand === previousDefaultUpdateCommand
        ? defaultPreferences.defaultUpdateCommand
        : savedUpdateCommand
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
    quickCommands: cleanStringList(input.quickCommands, previous?.quickCommands ?? []),
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
  return mutateStore((store) => {
    const index = id
      ? store.profiles.findIndex((profile) => profile.id === id)
      : -1;
    const profile = normalizeProfile(input, index >= 0 ? store.profiles[index] : undefined);

    if (index >= 0) {
      store.profiles[index] = profile;
    } else {
      store.profiles.unshift(profile);
    }
    return profile;
  });
}

export async function deleteProfile(id: string) {
  return mutateStore((store) => {
    const previousLength = store.profiles.length;
    store.profiles = store.profiles.filter((profile) => profile.id !== id);
    return store.profiles.length !== previousLength;
  });
}

export async function getPreferences() {
  return (await readStore()).preferences;
}

export async function savePreferences(input: Partial<AppPreferences>) {
  return mutateStore((store) => {
    const preferences = normalizePreferences({ ...store.preferences, ...input });
    store.preferences = preferences;
    return preferences;
  });
}

export async function getThreadMetadata() {
  return (await readStore()).threadMetadata;
}

export async function exportProfileBundle() {
  const profiles = await listProfiles();
  return {
    schemaVersion: 1,
    exportedAt: now(),
    secretsIncluded: false,
    profiles: profiles.map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...profile }) => profile)
  };
}

export async function importProfileBundle(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid profile bundle.");
  }
  const bundle = input as { schemaVersion?: unknown; profiles?: unknown };
  if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.profiles)) {
    throw new Error("Unsupported profile bundle version.");
  }
  if (bundle.profiles.length > 100) {
    throw new Error("A profile bundle can contain at most 100 projects.");
  }

  return mutateStore((store) => {
    const imported: CodexProfile[] = [];
    const skipped: string[] = [];
    for (const value of bundle.profiles as unknown[]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Profile bundle contains an invalid project.");
      }
      const candidate = value as Record<string, unknown>;
      if (candidate.mode !== "ssh" && candidate.mode !== "local") {
        throw new Error("Profile bundle contains an invalid connection mode.");
      }
      if (candidate.approvalPolicy && !["never", "on-request", "on-failure", "untrusted"].includes(String(candidate.approvalPolicy))) {
        throw new Error("Profile bundle contains an invalid approval policy.");
      }
      if (candidate.sandboxMode && !["danger-full-access", "workspace-write", "read-only"].includes(String(candidate.sandboxMode))) {
        throw new Error("Profile bundle contains an invalid sandbox mode.");
      }
      const profile = normalizeProfile(candidate as ProfileInput);
      const duplicate = store.profiles.some((item) =>
        item.mode === profile.mode &&
        item.sshTarget === profile.sshTarget &&
        item.projectPath === profile.projectPath
      );
      if (duplicate) {
        skipped.push(profile.name);
        continue;
      }
      imported.push(profile);
      store.profiles.unshift(profile);
    }
    return { imported, skipped };
  });
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
  return mutateStore((store) => {
    const current = store.threadMetadata[threadId] ?? {};
    const next = normalizeThreadMetadata(current, input);

    if (hasThreadMetadata(next)) {
      store.threadMetadata[threadId] = next;
    } else {
      delete store.threadMetadata[threadId];
    }
    return store.threadMetadata[threadId] ?? {};
  });
}

export { defaultPreferences, defaultUpdateCommand };
