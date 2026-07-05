import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";

import { CodexBridge } from "./codexBridge";
import {
  deleteProfile,
  getProfile,
  listProfiles,
  saveProfile
} from "./profiles";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT ?? 5173);
const isProduction = process.env.NODE_ENV === "production";

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

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

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
        bridge = new CodexBridge(profile);
        wireBridge(bridge);
        await bridge.start();
        send(ws, { type: "connection", status: "connected", profile });
        send(ws, { type: "threads", result: await bridge.listThreads() });
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
          result: await bridge.listThreads({ searchTerm: message.searchTerm })
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
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`Codex Remote listening on http://127.0.0.1:${port}`);
});

