export type ActiveTurnIdentity = {
  threadId?: string;
  turnId?: string;
};

export type ParsedTurnEvent = ActiveTurnIdentity & {
  status?: string;
  durationMs?: number | null;
  completedAtSeconds?: number | null;
  errorMessage?: string;
};

export type TurnCompletionDecision =
  | {
      shouldComplete: true;
      status: string;
      durationMs?: number | null;
      completedAtSeconds?: number | null;
      errorMessage?: string;
    }
  | {
      shouldComplete: false;
      reason: "different-thread" | "different-turn" | "turn-not-started" | "non-terminal-status";
    };

const terminalStatuses = new Set(["completed", "interrupted", "failed"]);

export function codexReasoningEffortValue(
  level: "low" | "medium" | "high" | "very-high"
) {
  if (level === "very-high") return "xhigh";
  return level;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function turnErrorMessage(turn: Record<string, unknown> | null) {
  const error = asRecord(turn?.error);
  return stringValue(error?.message) || stringValue(error?.error) || stringValue(turn?.error);
}

export function parseTurnEvent(params: unknown): ParsedTurnEvent {
  const record = asRecord(params);
  const turn = asRecord(record?.turn);
  return {
    threadId: stringValue(record?.threadId),
    turnId: stringValue(record?.turnId) || stringValue(turn?.id),
    status: stringValue(record?.status) || stringValue(turn?.status),
    durationMs: numberValue(record?.durationMs) ?? numberValue(turn?.durationMs),
    completedAtSeconds:
      numberValue(record?.completedAt) ?? numberValue(turn?.completedAt),
    errorMessage: turnErrorMessage(turn)
  };
}

export function mergeTurnIdentity(
  current: ActiveTurnIdentity,
  params: unknown
): ActiveTurnIdentity {
  const next = parseTurnEvent(params);
  return {
    threadId: next.threadId ?? current.threadId,
    turnId: next.turnId ?? current.turnId
  };
}

export function isTurnEventForActiveTask(
  current: ActiveTurnIdentity,
  params: unknown
) {
  const next = parseTurnEvent(params);
  if (current.threadId && next.threadId && current.threadId !== next.threadId) {
    return false;
  }
  if (current.turnId && next.turnId && current.turnId !== next.turnId) {
    return false;
  }
  return true;
}

export function completionDecisionForActiveTask(
  current: ActiveTurnIdentity,
  params: unknown
): TurnCompletionDecision {
  const next = parseTurnEvent(params);
  if (current.threadId && next.threadId && current.threadId !== next.threadId) {
    return { shouldComplete: false, reason: "different-thread" };
  }
  if (current.turnId && next.turnId && current.turnId !== next.turnId) {
    return { shouldComplete: false, reason: "different-turn" };
  }
  if (!current.turnId) {
    return { shouldComplete: false, reason: "turn-not-started" };
  }

  const status = next.status || "completed";
  if (!terminalStatuses.has(status)) {
    return { shouldComplete: false, reason: "non-terminal-status" };
  }

  return {
    shouldComplete: true,
    status,
    durationMs: next.durationMs,
    completedAtSeconds: next.completedAtSeconds,
    errorMessage: next.errorMessage
  };
}
