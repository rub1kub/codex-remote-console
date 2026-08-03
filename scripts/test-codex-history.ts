import { CodexBridge } from "../server/codexBridge";
import type { CodexProfile, JsonRpcMessage } from "../server/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const profile: CodexProfile = {
  id: "test-profile",
  name: "Test",
  mode: "local",
  sshTarget: "",
  projectPath: "/tmp",
  codexBin: "codex",
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z"
};

type TestBridge = {
  rpcStream?: unknown;
  handleLine: (line: string) => void;
};

type RecordedRequest = {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
};

function bridgeWithResponses(
  respond: (request: RecordedRequest) => { result?: unknown; error?: { code: number; message: string } }
) {
  const bridge = new CodexBridge(profile);
  const testBridge = bridge as unknown as TestBridge;
  const requests: RecordedRequest[] = [];
  const stream = {
    destroyed: false,
    writable: true,
    write(line: string) {
      const request = JSON.parse(line) as RecordedRequest;
      requests.push(request);
      const response = respond(request);
      queueMicrotask(() => {
        testBridge.handleLine(JSON.stringify({ id: request.id, ...response } satisfies JsonRpcMessage));
      });
      return true;
    },
    end() {
      this.destroyed = true;
      this.writable = false;
    }
  };
  testBridge.rpcStream = stream;
  return { bridge, requests };
}

async function testPaginatedHistory() {
  const { bridge, requests } = bridgeWithResponses((request) => {
    if (request.method === "thread/read") {
      return { result: { thread: { id: "thread-1", preview: "History", turns: [] } } };
    }
    if (request.method === "thread/turns/list") {
      if (request.params.cursor === null) {
        return {
          result: {
            data: [{ id: "turn-1", status: "completed", items: [] }],
            nextCursor: "turn-page-2"
          }
        };
      }
      return {
        result: {
          data: [{ id: "turn-2", status: "completed", items: [] }],
          nextCursor: null
        }
      };
    }
    if (request.method === "thread/items/list") {
      if (request.params.turnId === "turn-1" && request.params.cursor === null) {
        return {
          result: {
            data: [{ type: "userMessage", id: "item-1", content: [] }],
            nextCursor: "item-page-2"
          }
        };
      }
      if (request.params.turnId === "turn-1") {
        return {
          result: {
            data: [{ type: "agentMessage", id: "item-2", text: "Done" }],
            nextCursor: null
          }
        };
      }
      return {
        result: {
          data: [{ type: "agentMessage", id: "item-3", text: "Next" }],
          nextCursor: null
        }
      };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });

  const result = await bridge.readThread("thread-1") as {
    thread: { turns: Array<{ id: string; items: Array<{ id: string }>; itemsView: string }> };
  };

  assert(result.thread.turns.length === 2, "turn pagination did not preserve every turn");
  assert(result.thread.turns[0].items.map((item) => item.id).join(",") === "item-1,item-2", "item pagination lost order or data");
  assert(result.thread.turns[1].items[0]?.id === "item-3", "items were assigned to the wrong turn");
  assert(result.thread.turns.every((turn) => turn.itemsView === "full"), "assembled turns are not marked as fully loaded");
  assert(
    requests.filter((request) => request.method === "thread/read").every((request) => request.params.includeTurns === false),
    "paginated history unexpectedly requested a monolithic transcript"
  );
  bridge.dispose();
}

async function testLegacyFallback() {
  let readCount = 0;
  const { bridge, requests } = bridgeWithResponses((request) => {
    if (request.method === "thread/read") {
      readCount += 1;
      return readCount === 1
        ? { result: { thread: { id: "thread-legacy", turns: [] } } }
        : { result: { thread: { id: "thread-legacy", turns: [{ id: "turn-legacy", items: [] }] } } };
    }
    if (request.method === "thread/turns/list") {
      return { error: { code: -32601, message: "Method not found" } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });

  const result = await bridge.readThread("thread-legacy") as { thread: { turns: unknown[] } };
  const reads = requests.filter((request) => request.method === "thread/read");
  assert(result.thread.turns.length === 1, "legacy history fallback did not return the transcript");
  assert(reads.length === 2, "legacy history fallback did not retry thread/read");
  assert(reads[0].params.includeTurns === false && reads[1].params.includeTurns === true, "legacy fallback used the wrong read mode");
  bridge.dispose();
}

await testPaginatedHistory();
await testLegacyFallback();

console.log("codex history: ok");
