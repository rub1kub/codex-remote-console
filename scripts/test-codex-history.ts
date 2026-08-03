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
      return {
        result: {
          data: [
            {
              id: "turn-2",
              status: "completed",
              itemsView: "summary",
              items: [{ type: "agentMessage", id: "item-3", text: "Next" }]
            },
            {
              id: "turn-1",
              status: "completed",
              itemsView: "summary",
              items: [
                { type: "userMessage", id: "item-1", content: [] },
                { type: "agentMessage", id: "item-2", text: "Done" }
              ]
            }
          ],
          nextCursor: "older-turns"
        }
      };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });

  const result = await bridge.readThread("thread-1") as {
    thread: { turns: Array<{ id: string; items: Array<{ id: string }>; itemsView: string }> };
  };

  assert(result.thread.turns.length === 2, "turn pagination did not preserve every turn");
  assert(result.thread.turns[0].items.map((item) => item.id).join(",") === "item-1,item-2", "turn pagination lost item order or data");
  assert(result.thread.turns[1].items[0]?.id === "item-3", "items were assigned to the wrong turn");
  assert(result.thread.turns.every((turn) => turn.itemsView === "summary"), "assembled turns are not marked as summary history");
  assert(
    requests.filter((request) => request.method === "thread/turns/list").every((request) => request.params.itemsView === "summary"),
    "turn pages did not request summary items"
  );
  assert(requests.filter((request) => request.method === "thread/turns/list").length === 1, "history waited for more than one turn page");
  assert(
    requests.find((request) => request.method === "thread/turns/list")?.params.sortDirection === "desc",
    "history did not request the newest turn page first"
  );
  assert(!requests.some((request) => request.method === "thread/items/list"), "unsupported thread/items/list was requested");
  assert(
    requests.filter((request) => request.method === "thread/read").every((request) => request.params.includeTurns === false),
    "paginated history unexpectedly requested a monolithic transcript"
  );
  bridge.dispose();
}

async function testUnsupportedPaginationFallback() {
  let readCount = 0;
  const { bridge, requests } = bridgeWithResponses((request) => {
    if (request.method === "thread/read") {
      readCount += 1;
      return readCount === 1
        ? { result: { thread: { id: "thread-legacy", turns: [] } } }
        : { result: { thread: { id: "thread-legacy", turns: [{ id: "turn-legacy", items: [] }] } } };
    }
    if (request.method === "thread/turns/list") {
      return { error: { code: -32601, message: "thread/turns/list is not supported yet" } };
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

async function testEmptySummaryLoadsFullHistory() {
  let readCount = 0;
  const { bridge, requests } = bridgeWithResponses((request) => {
    if (request.method === "thread/read") {
      readCount += 1;
      return readCount === 1
        ? { result: { thread: { id: "thread-resume", turns: [] } } }
        : {
            result: {
              thread: {
                id: "thread-resume",
                turns: [{
                  id: "turn-restored",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-restored", text: "Restored" }]
                }]
              }
            }
          };
    }
    if (request.method === "thread/turns/list") {
      return {
        result: {
          data: [{ id: "turn-empty", status: "completed", itemsView: "summary", items: [] }],
          nextCursor: null
        }
      };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });

  const result = await bridge.readThread("thread-resume") as {
    thread: { turns: Array<{ items: Array<{ id: string }> }> };
  };
  assert(result.thread.turns[0]?.items[0]?.id === "item-restored", "empty summary did not load full history");
  assert(requests.filter((request) => request.method === "thread/read").length === 2, "empty summary did not trigger a full read");
  assert(requests.filter((request) => request.method === "thread/read")[1]?.params.includeTurns === true, "empty summary fallback omitted turns");
  bridge.dispose();
}

async function testEmptySummaryPageLoadsFullHistory() {
  let readCount = 0;
  const { bridge, requests } = bridgeWithResponses((request) => {
    if (request.method === "thread/read") {
      readCount += 1;
      return readCount === 1
        ? { result: { thread: { id: "thread-empty-page", turns: [] } } }
        : {
            result: {
              thread: {
                id: "thread-empty-page",
                turns: [{
                  id: "turn-restored",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-restored", text: "Restored" }]
                }]
              }
            }
          };
    }
    if (request.method === "thread/turns/list") {
      return { result: { data: [], nextCursor: null } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });

  const result = await bridge.readThread("thread-empty-page") as {
    thread: { turns: Array<{ items: Array<{ id: string }> }> };
  };
  assert(result.thread.turns[0]?.items[0]?.id === "item-restored", "empty summary page did not load full history");
  assert(requests.filter((request) => request.method === "thread/read").length === 2, "empty summary page did not trigger a full read");
  assert(requests.filter((request) => request.method === "thread/read")[1]?.params.includeTurns === true, "empty summary page fallback omitted turns");
  bridge.dispose();
}

async function testNonDisplayableSummaryLoadsFullHistory() {
  let readCount = 0;
  const { bridge, requests } = bridgeWithResponses((request) => {
    if (request.method === "thread/read") {
      readCount += 1;
      return readCount === 1
        ? { result: { thread: { id: "thread-non-displayable", turns: [] } } }
        : {
            result: {
              thread: {
                id: "thread-non-displayable",
                turns: [{
                  id: "turn-restored",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-restored", text: "Restored" }]
                }]
              }
            }
          };
    }
    if (request.method === "thread/turns/list") {
      return {
        result: {
          data: [{
            id: "turn-summary-only",
            status: "completed",
            itemsView: "summary",
            items: [{ type: "reasoning", id: "item-reasoning", summary: [] }]
          }],
          nextCursor: null
        }
      };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });

  const result = await bridge.readThread("thread-non-displayable") as {
    thread: { turns: Array<{ items: Array<{ id: string }> }> };
  };
  assert(result.thread.turns[0]?.items[0]?.id === "item-restored", "non-displayable summary did not load full history");
  assert(requests.filter((request) => request.method === "thread/read").length === 2, "non-displayable summary did not trigger a full read");
  assert(requests.filter((request) => request.method === "thread/read")[1]?.params.includeTurns === true, "non-displayable summary fallback omitted turns");
  bridge.dispose();
}

async function testUnmaterializedThreadOpensEmpty() {
  const { bridge, requests } = bridgeWithResponses((request) => {
    if (request.method === "thread/read") {
      return { result: { thread: { id: "thread-new", turns: [] } } };
    }
    if (request.method === "thread/turns/list") {
      return {
        error: {
          code: -32602,
          message: "thread thread-new is not materialized yet; thread/turns/list is unavailable before first user message"
        }
      };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });

  const result = await bridge.readThread("thread-new") as { thread: { turns: unknown[] } };
  assert(Array.isArray(result.thread.turns) && result.thread.turns.length === 0, "unmaterialized thread did not open with empty history");
  assert(requests.filter((request) => request.method === "thread/read").length === 1, "unmaterialized thread triggered an unnecessary extra read");
  assert(!requests.some((request) => request.method === "thread/read" && request.params.includeTurns === true), "unmaterialized thread fell back to the legacy monolithic read");
  bridge.dispose();
}

await testPaginatedHistory();
await testUnsupportedPaginationFallback();
await testEmptySummaryLoadsFullHistory();
await testEmptySummaryPageLoadsFullHistory();
await testNonDisplayableSummaryLoadsFullHistory();
await testUnmaterializedThreadOpensEmpty();

console.log("codex history: ok");
