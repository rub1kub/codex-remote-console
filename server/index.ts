import express from "express";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

import { CodexBridge } from "./codexBridge";
import {
  deleteProfile,
  getProfile,
  getPreferences,
  listProfiles,
  savePreferences,
  saveProfile
} from "./profiles";
import { checkCodexCli, updateCodexCli } from "./remoteExec";

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

export async function startServer(
  options: StartServerOptions = {}
): Promise<ServerHandle> {
  const root = options.root ?? process.cwd();
  const port = options.port ?? Number(process.env.PORT ?? 5173);
  const host = options.host ?? "127.0.0.1";
  const isProduction =
    options.isProduction ?? process.env.NODE_ENV === "production";

  const app = express();
  app.use(express.json({ limit: "1mb" }));

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

  app.get("/api/preferences", async (_request, response, next) => {
    try {
      response.json({ preferences: await getPreferences() });
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
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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
        send(ws, { type: "codexStatus", status });
      });
    };

    const closeBridge = () => {
      bridge?.dispose();
      bridge = undefined;
    };

    ws.on("close", closeBridge);

    ws.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString("utf8")) as {
          type: string;
          profileId?: string;
          password?: string;
          threadId?: string;
          text?: string;
          searchTerm?: string;
        };

        if (message.type === "connect") {
          if (!message.profileId) throw new Error("profileId is required.");
          const profile = await getProfile(message.profileId);
          if (!profile) throw new Error("Profile not found.");

          closeBridge();
          send(ws, { type: "connection", status: "connecting", profile });
          bridge = new CodexBridge(profile, {
            password: message.password?.trim() || undefined
          });
          wireBridge(bridge);
          await bridge.start();
          send(ws, { type: "connection", status: "connected", profile });
          send(ws, {
            type: "threads",
            result: await bridge.listThreads({
              limit: (await getPreferences()).historyLimit
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
            result: null
          });
          send(ws, {
            type: "codexCli",
            phase: "checked",
            result: await checkCodexCli(
              profile,
              { password: message.password?.trim() || undefined },
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
            result: null
          });
          send(ws, {
            type: "codexCli",
            phase: "updated",
            result: await updateCodexCli(
              profile,
              { password: message.password?.trim() || undefined },
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

        if (message.type === "listThreads") {
          send(ws, {
            type: "threads",
            result: await bridge.listThreads({
              searchTerm: message.searchTerm,
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
        } else if (message.type === "resumeThread") {
          if (!message.threadId) throw new Error("threadId is required.");
          send(ws, {
            type: "thread",
            result: await bridge.resumeThread(message.threadId)
          });
        } else if (message.type === "sendMessage") {
          const text = message.text?.trim();
          if (!text) throw new Error("Message is empty.");
          send(ws, {
            type: "turn",
            result: await bridge.sendTurn(text, message.threadId)
          });
        } else if (message.type === "interrupt") {
          send(ws, { type: "interrupt", result: await bridge.interrupt() });
        }
      } catch (error) {
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
