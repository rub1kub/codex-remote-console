import assert from "node:assert/strict";

import {
  completionDecisionForActiveTask,
  isTurnEventForActiveTask,
  mergeTurnIdentity,
  parseTurnEvent
} from "../src/taskProtocol";

const active = { threadId: "thread-current", turnId: "turn-current" };

assert.deepEqual(
  parseTurnEvent({
    threadId: "thread-current",
    turn: {
      id: "turn-current",
      status: "completed",
      completedAt: 1783548000,
      durationMs: 12_500
    }
  }),
  {
    threadId: "thread-current",
    turnId: "turn-current",
    status: "completed",
    completedAtSeconds: 1783548000,
    durationMs: 12_500,
    errorMessage: undefined
  }
);

assert.equal(
  isTurnEventForActiveTask(active, {
    threadId: "thread-current",
    turnId: "turn-current"
  }),
  true
);

assert.equal(
  isTurnEventForActiveTask(active, {
    threadId: "thread-current",
    turnId: "turn-old"
  }),
  false
);

assert.deepEqual(
  completionDecisionForActiveTask(active, {
    threadId: "thread-current",
    turn: { id: "turn-old", status: "completed" }
  }),
  { shouldComplete: false, reason: "different-turn" }
);

assert.deepEqual(
  completionDecisionForActiveTask(active, {
    threadId: "thread-old",
    turn: { id: "turn-current", status: "completed" }
  }),
  { shouldComplete: false, reason: "different-thread" }
);

assert.deepEqual(
  completionDecisionForActiveTask(active, {
    threadId: "thread-current",
    turn: { id: "turn-current", status: "inProgress" }
  }),
  { shouldComplete: false, reason: "non-terminal-status" }
);

assert.equal(
  completionDecisionForActiveTask(active, {
    threadId: "thread-current",
    turn: { id: "turn-current", status: "completed" }
  }).shouldComplete,
  true
);

assert.deepEqual(
  mergeTurnIdentity({ threadId: "thread-current" }, {
    threadId: "thread-current",
    turn: { id: "turn-current" }
  }),
  active
);

console.log("task protocol: ok");
