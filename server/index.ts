import express from "express";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

import { CodexBridge } from "./codexBridge";
import {
  AgentsRevisionConflictError,
  commitProjectChanges,
  createProjectCheckpoint,
  getProjectGitStatus,
  inspectProjectRuntime,
  listProjectBranches,
  pushCurrentBranch,
  readRootAgentsFile,
  stageProjectPaths,
  unstageProjectPaths,
  writeRootAgentsFile
} from "./projectTools";
import {
  deleteProfile,
  exportProfileBundle,
  getProfile,
  getPreferences,
  getThreadMetadata,
  importProfileBundle,
  listProfiles,
  saveThreadMetadata,
  savePreferences,
  saveProfile
} from "./profiles";
import {
  checkCodexCli,
  inspectMcpServers,
  inspectProjectHealth,
  listProjectFiles,
  listDirectories,
  preflightCodexCli,
  readProjectFile,
  readProjectDiff,
  runProjectQuickCommand,
  searchProjectFiles,
  updateCodexCli
} from "./remoteExec";
import {
  deleteProfileSecret,
  getSecretStatus,
  readProfileSecret,
  saveProfileSecret
} from "./secrets";
import type { AppUpdateStatus } from "./types";
import type { ReviewTarget, UserInput } from "./types";

type StartServerOptions = {
  host?: string;
  port?: number;
  root?: string;
  isProduction?: boolean;
};

type ServerHandle = {
  app: express.Express;
  httpServer: Server;
  url: string;
  close: () => Promise<void>;
};

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function isLoopbackHostname(value: string) {
  const hostname = value.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function isAllowedLocalRequest(hostHeader?: string, originHeader?: string) {
  const hostValue = (hostHeader || "").trim();
  const hostname = hostValue.startsWith("[")
    ? hostValue.slice(1, hostValue.indexOf("]"))
    : hostValue.split(":")[0];
  if (!isLoopbackHostname(hostname)) return false;
  if (!originHeader) return true;
  try {
    return isLoopbackHostname(new URL(originHeader).hostname);
  } catch {
    return false;
  }
}

async function getProfileWithSecrets(body: Record<string, unknown> = {}) {
  const profileId = typeof body.profileId === "string" ? body.profileId : "";
  if (!profileId) throw new Error("profileId is required.");

  const profile = await getProfile(profileId);
  if (!profile) throw new Error("Profile not found.");

  return {
    profile,
    secrets: {
      password:
        typeof body.password === "string" && body.password.trim()
          ? body.password.trim()
          : await readProfileSecret(profileId)
    }
  };
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

async function readAppVersion(root: string) {
  const raw = await readFile(path.join(root, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version || "0.0.0";
}

async function checkAppUpdate(root: string, channel: "stable" | "preview" = "stable"): Promise<AppUpdateStatus> {
  const current = await readAppVersion(root);
  const fallbackUrl = "https://github.com/rub1kub/codex-remote-console/releases";
  const includePrerelease = channel === "preview";
  try {
    const url = includePrerelease
      ? "https://api.github.com/repos/rub1kub/codex-remote-console/releases?per_page=20"
      : "https://api.github.com/repos/rub1kub/codex-remote-console/releases/latest";
    const result = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!result.ok) throw new Error(`GitHub returned ${result.status}`);
    const data = await result.json() as { tag_name?: string; html_url?: string; draft?: boolean } | Array<{ tag_name?: string; html_url?: string; draft?: boolean }>;
    const release = Array.isArray(data)
      ? data.find((item) => !item.draft) ?? data[0]
      : data;
    const latest = (release?.tag_name || "").replace(/^v/, "") || current;
    return {
      current,
      latest,
      updateAvailable: compareVersions(current, latest) < 0,
      releaseUrl: release?.html_url || fallbackUrl
    };
  } catch (error) {
    return {
      current,
      latest: current,
      updateAvailable: false,
      releaseUrl: fallbackUrl,
      error: error instanceof Error ? error.message : "Не удалось проверить релиз."
    };
  }
}

export async function startServer(
  options: StartServerOptions = {}
): Promise<ServerHandle> {
  const root = options.root ?? process.cwd();
  const port = options.port ?? Number(process.env.PORT ?? 5173);
  const host = options.host ?? "127.0.0.1";
  const isProduction =
    options.isProduction ?? process.env.NODE_ENV === "production";

  const app = express();
  app.use((request, response, next) => {
    if (!isAllowedLocalRequest(request.headers.host, request.headers.origin)) {
      response.status(403).json({ error: "Local request required." });
      return;
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/profiles", async (_request, response, next) => {
    try {
      response.json({ profiles: await listProfiles() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/profiles/export", async (_request, response, next) => {
    try {
      response.json({ bundle: await exportProfileBundle() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/import", async (request, response, next) => {
    try {
      response.json(await importProfileBundle(request.body?.bundle));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/preferences", async (_request, response, next) => {
    try {
      response.json({ preferences: await getPreferences() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/app-update", async (_request, response, next) => {
    try {
      const preferences = await getPreferences();
      response.json({ update: await checkAppUpdate(root, preferences.appUpdateChannel) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/secrets", async (_request, response, next) => {
    try {
      response.json({ secrets: await getSecretStatus() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/secrets/:profileId", async (request, response, next) => {
    try {
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      response.json({ secrets: await saveProfileSecret(request.params.profileId, password) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/secrets/:profileId", async (request, response, next) => {
    try {
      response.json({ secrets: await deleteProfileSecret(request.params.profileId) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/preferences", async (request, response, next) => {
    try {
      response.json({ preferences: await savePreferences(request.body) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/thread-metadata", async (_request, response, next) => {
    try {
      response.json({ threadMetadata: await getThreadMetadata() });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/thread-metadata/:threadId", async (request, response, next) => {
    try {
      response.json({
        metadata: await saveThreadMetadata(request.params.threadId, request.body ?? {})
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/directories", async (request, response, next) => {
    try {
      const { password, ...input } = request.body ?? {};
      response.json({
        listing: await listDirectories(input, {
          password: typeof password === "string" ? password : undefined
        })
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/health", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      response.json({ health: await inspectProjectHealth(profile, secrets) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/git/status", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      response.json({ status: await getProjectGitStatus(profile, secrets) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/git/branches", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      response.json({ branches: await listProjectBranches(profile, secrets) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/git/stage", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const paths = Array.isArray(request.body?.paths)
        ? request.body.paths.filter((value: unknown): value is string => typeof value === "string")
        : [];
      response.json({ status: await stageProjectPaths(profile, secrets, paths) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/git/unstage", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const paths = Array.isArray(request.body?.paths)
        ? request.body.paths.filter((value: unknown): value is string => typeof value === "string")
        : [];
      response.json({ status: await unstageProjectPaths(profile, secrets, paths) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/git/commit", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const message = typeof request.body?.message === "string" ? request.body.message : "";
      response.json({ commit: await commitProjectChanges(profile, secrets, message) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/git/push", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      response.json({ push: await pushCurrentBranch(profile, secrets) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/checkpoint", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const label = typeof request.body?.label === "string" ? request.body.label : "";
      response.json({ checkpoint: await createProjectCheckpoint(profile, secrets, label) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/runtime", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      response.json({ runtime: await inspectProjectRuntime(profile, secrets) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/instructions", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      response.json({ file: await readRootAgentsFile(profile, secrets) });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/project/instructions", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const content = typeof request.body?.content === "string" ? request.body.content : "";
      const expectedRevision = typeof request.body?.expectedRevision === "string"
        ? request.body.expectedRevision
        : "";
      response.json({
        file: await writeRootAgentsFile(profile, secrets, content, expectedRevision)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/diff", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const files = Array.isArray(request.body?.files)
        ? request.body.files.filter((file: unknown): file is string => typeof file === "string")
        : [];
      response.json({ diff: await readProjectDiff(profile, secrets, files) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/tree", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const directoryPath = typeof request.body?.path === "string" ? request.body.path : ".";
      response.json({ listing: await listProjectFiles(profile, secrets, directoryPath) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/file", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const filePath = typeof request.body?.path === "string" ? request.body.path : "";
      response.json({ file: await readProjectFile(profile, secrets, filePath) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/files", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const query = typeof request.body?.query === "string" ? request.body.query : "";
      response.json({ files: await searchProjectFiles(profile, secrets, query) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/command", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      const command = typeof request.body?.command === "string" ? request.body.command : "";
      response.json({ result: await runProjectQuickCommand(profile, secrets, command) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/codex/mcp", async (request, response, next) => {
    try {
      const { profile, secrets } = await getProfileWithSecrets(request.body ?? {});
      response.json({ mcp: await inspectMcpServers(profile, secrets) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles", async (request, response, next) => {
    try {
      response.status(201).json({ profile: await saveProfile(request.body) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:id", async (request, response, next) => {
    try {
      response.json({ profile: await saveProfile(request.body, request.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/profiles/:id", async (request, response, next) => {
    try {
      response.json({ deleted: await deleteProfile(request.params.id) });
    } catch (error) {
      next(error);
    }
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    verifyClient: ({ req }, done) => {
      done(isAllowedLocalRequest(req.headers.host, req.headers.origin), 403, "Local request required.");
    }
  });

  wss.on("connection", (ws) => {
    let bridge: CodexBridge | undefined;

    const wireBridge = (nextBridge: CodexBridge) => {
      nextBridge.on("notification", (message) => {
        send(ws, { type: "notification", message });
      });
      nextBridge.on("stderr", (line) => {
        send(ws, { type: "log", line });
      });
      nextBridge.on("status", (status) => {
        if (bridge !== nextBridge) return;
        send(ws, { type: "codexStatus", status });
        if (status === "closed" || status.startsWith("error:")) {
          bridge = undefined;
          send(ws, { type: "connection", status: "idle" });
        }
      });
    };

    const closeBridge = () => {
      bridge?.dispose();
      bridge = undefined;
    };

    const publishModels = async (currentBridge: CodexBridge) => {
      try {
        send(ws, { type: "models", result: await currentBridge.listModels() });
      } catch (error) {
        send(ws, {
          type: "models",
          result: { data: [], nextCursor: null },
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };

    ws.on("close", closeBridge);

    ws.on("message", async (raw) => {
      let messageType = "";
      try {
        const message = JSON.parse(raw.toString("utf8")) as {
          type: string;
          profileId?: string;
          password?: string;
          threadId?: string;
          text?: string;
          searchTerm?: string;
          archived?: boolean;
          input?: UserInput[];
          requestId?: number | string;
          result?: unknown;
          target?: ReviewTarget;
          effort?: string | null;
          serviceTier?: string | null;
        };
        messageType = message.type;

        if (message.type === "connect") {
          if (!message.profileId) throw new Error("profileId is required.");
          const profile = await getProfile(message.profileId);
          if (!profile) throw new Error("Profile not found.");

          closeBridge();
          const secrets = {
            password: message.password?.trim() || await readProfileSecret(message.profileId)
          };
          const preferences = await getPreferences();
          send(ws, { type: "connection", status: "connecting", profile });
          const preflight = await preflightCodexCli(
            profile,
            secrets,
            preferences
          );
          send(ws, {
            type: "codexCli",
            phase: "checked",
            profileId: profile.id,
            result: preflight
          });
          if (preflight.missing || preflight.broken) {
            throw new Error(preflight.message || "Codex CLI не найден.");
          }
          bridge = new CodexBridge(profile, secrets);
          wireBridge(bridge);
          await bridge.start();
          send(ws, { type: "connection", status: "connected", profile });
          await publishModels(bridge);
          send(ws, {
            type: "threads",
            result: await bridge.listThreads({
              limit: preferences.historyLimit
            })
          });
          return;
        }

        if (message.type === "checkCodexCli") {
          if (!message.profileId) throw new Error("profileId is required.");
          const profile = await getProfile(message.profileId);
          if (!profile) throw new Error("Profile not found.");
          send(ws, {
            type: "codexCli",
            phase: "checking",
            profileId: profile.id,
            result: null
          });
          send(ws, {
            type: "codexCli",
            phase: "checked",
            profileId: profile.id,
            result: await checkCodexCli(
              profile,
              { password: message.password?.trim() || await readProfileSecret(message.profileId) },
              await getPreferences()
            )
          });
          return;
        }

        if (message.type === "updateCodexCli") {
          if (!message.profileId) throw new Error("profileId is required.");
          const profile = await getProfile(message.profileId);
          if (!profile) throw new Error("Profile not found.");
          send(ws, {
            type: "codexCli",
            phase: "updating",
            profileId: profile.id,
            result: null
          });
          send(ws, {
            type: "codexCli",
            phase: "updated",
            profileId: profile.id,
            result: await updateCodexCli(
              profile,
              { password: message.password?.trim() || await readProfileSecret(message.profileId) },
              await getPreferences()
            )
          });
          return;
        }

        if (message.type === "disconnect") {
          closeBridge();
          send(ws, { type: "connection", status: "idle" });
          return;
        }

        if (!bridge) {
          throw new Error("Connect to a profile first.");
        }

        if (message.type === "listModels") {
          await publishModels(bridge);
        } else if (message.type === "listThreads") {
          send(ws, {
            type: "threads",
            result: await bridge.listThreads({
              searchTerm: message.searchTerm,
              archived: Boolean(message.archived),
              limit: (await getPreferences()).historyLimit
            })
          });
        } else if (message.type === "newThread") {
          send(ws, { type: "thread", result: await bridge.startThread() });
        } else if (message.type === "readThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          send(ws, {
            type: "thread",
            result: await bridge.readThread(message.threadId)
          });
        } else if (message.type === "deleteThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          await bridge.deleteThread(message.threadId);
          send(ws, {
            type: "threadDeleted",
            threadId: message.threadId,
            archived: false
          });
        } else if (message.type === "archiveThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          try {
            await bridge.archiveThread(message.threadId);
            send(ws, {
              type: "threadDeleted",
              threadId: message.threadId,
              archived: true
            });
          } catch (error) {
            send(ws, {
              type: "threadDeleted",
              threadId: message.threadId,
              archived: false,
              archiveError: error instanceof Error ? error.message : String(error)
            });
          }
        } else if (message.type === "forkThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          send(ws, {
            type: "thread",
            result: await bridge.forkThread(message.threadId)
          });
        } else if (message.type === "compactThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          send(ws, { type: "turn", result: await bridge.compactThread(message.threadId) });
        } else if (message.type === "unarchiveThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          await bridge.unarchiveThread(message.threadId);
          send(ws, {
            type: "threadDeleted",
            threadId: message.threadId,
            archived: false
          });
        } else if (message.type === "resumeThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          send(ws, {
            type: "thread",
            result: await bridge.resumeThread(message.threadId)
          });
        } else if (message.type === "reviewStart") {
          if (!message.target) throw new Error("review target is required.");
          send(ws, {
            type: "turn",
            result: await bridge.startReview(message.target, message.threadId)
          });
        } else if (message.type === "respondRequest") {
          if (message.requestId === undefined) throw new Error("requestId is required.");
          bridge.respondRequest(message.requestId, message.result ?? {});
        } else if (message.type === "sendMessage") {
          const text = message.text?.trim();
          const input = Array.isArray(message.input) ? message.input : [];
          if (!text && input.length === 0) throw new Error("Message is empty.");
          send(ws, {
            type: "turn",
            result: await bridge.sendTurn(text ?? "", message.threadId, input, {
              effort: typeof message.effort === "string" ? message.effort : null,
              serviceTier: typeof message.serviceTier === "string" ? message.serviceTier : null
            })
          });
        } else if (message.type === "interrupt") {
          send(ws, { type: "interrupt", result: await bridge.interrupt() });
        }
      } catch (error) {
        if (messageType === "connect") {
          closeBridge();
          send(ws, { type: "connection", status: "idle" });
        }
        send(ws, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
  });

  if (isProduction) {
    app.use(express.static(path.join(root, "dist")));
    app.get("*", (_request, response) => {
      response.sendFile(path.join(root, "dist", "index.html"));
    });
  } else {
    const importRuntime = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<any>;
    const vite = await importRuntime("vite");
    const viteServer = await vite.createServer({
      root,
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(viteServer.middlewares);
  }

  app.use(
    (
      error: Error,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      if (error instanceof AgentsRevisionConflictError) {
        response.status(409).json({
          error: error.message,
          currentRevision: error.currentRevision
        });
        return;
      }
      response.status(400).json({ error: error.message });
    }
  );

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      console.log(`Codex Remote listening on ${url}`);
      resolve({
        app,
        httpServer,
        url,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            wss.close();
            httpServer.close((error) => {
              if (error) closeReject(error);
              else closeResolve();
            });
          })
      });
    });
  });
}

if (!process.env.CODEX_REMOTE_NO_AUTOSTART) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
