import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretStoreStatus } from "./types";

type SecretRecord = {
  encrypted: string;
  updatedAt: string;
};

type SecretStore = {
  salt: string;
  profiles: Record<string, SecretRecord>;
};

const electronRequire = createRequire(__filename);
const dataDir =
  process.env.CODEX_REMOTE_CONSOLE_HOME ??
  path.join(os.homedir(), ".codex-remote-console");
const secretStorePath = path.join(dataDir, "secrets.json");

function now() {
  return new Date().toISOString();
}

function getSafeStorage(): { available: boolean; reason?: string; api?: any } {
  try {
    const electron = electronRequire("electron") as {
      safeStorage?: {
        isEncryptionAvailable: () => boolean;
        encryptString: (plainText: string) => Buffer;
        decryptString: (encrypted: Buffer) => string;
      };
    };
    const api = electron.safeStorage;
    if (!api) return { available: false, reason: "Electron safeStorage недоступен." };
    if (!api.isEncryptionAvailable()) {
      return { available: false, reason: "Шифрование safeStorage недоступно в этой системе." };
    }
    return { available: true, api };
  } catch {
    return { available: false, reason: "Безопасное хранение доступно только в Electron-сборке." };
  }
}

async function readStore(): Promise<SecretStore> {
  try {
    const raw = await readFile(secretStorePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SecretStore>;
    return {
      salt: typeof parsed.salt === "string" ? parsed.salt : randomUUID(),
      profiles:
        parsed.profiles && typeof parsed.profiles === "object"
          ? parsed.profiles as Record<string, SecretRecord>
          : {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { salt: randomUUID(), profiles: {} };
    }
    throw error;
  }
}

async function writeStore(store: SecretStore) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(secretStorePath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
}

export async function getSecretStatus(): Promise<SecretStoreStatus> {
  const safeStorage = getSafeStorage();
  const store = await readStore();
  return {
    available: safeStorage.available,
    reason: safeStorage.reason,
    storedProfileIds: Object.keys(store.profiles)
  };
}

export async function saveProfileSecret(profileId: string, password: string) {
  const cleanProfileId = profileId.trim();
  const cleanPassword = password.trim();
  if (!cleanProfileId) throw new Error("profileId is required.");
  if (!cleanPassword) throw new Error("Password is empty.");

  const safeStorage = getSafeStorage();
  if (!safeStorage.available || !safeStorage.api) {
    throw new Error(safeStorage.reason || "Безопасное хранение недоступно.");
  }

  const store = await readStore();
  store.profiles[cleanProfileId] = {
    encrypted: safeStorage.api.encryptString(cleanPassword).toString("base64"),
    updatedAt: now()
  };
  await writeStore(store);
  return getSecretStatus();
}

export async function readProfileSecret(profileId: string) {
  const cleanProfileId = profileId.trim();
  if (!cleanProfileId) return undefined;
  const store = await readStore();
  const record = store.profiles[cleanProfileId];
  if (!record?.encrypted) return undefined;

  const safeStorage = getSafeStorage();
  if (!safeStorage.available || !safeStorage.api) return undefined;
  try {
    return safeStorage.api.decryptString(Buffer.from(record.encrypted, "base64")) || undefined;
  } catch {
    return undefined;
  }
}

export async function deleteProfileSecret(profileId: string) {
  const store = await readStore();
  delete store.profiles[profileId.trim()];
  await writeStore(store);
  return getSecretStatus();
}
