import {
  ArrowLeft,
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  Check,
  Circle,
  Command,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  History,
  KeyRound,
  Loader2,
  MessageSquare,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Pin,
  Power,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Trash2,
  X,
  Zap
} from "lucide-react";
import { FormEvent, KeyboardEvent, MouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  AppPreferences,
  ChatMessage,
  CodexCliStatus,
  CodexProfile,
  CodexThread,
  DirectoryListing,
  FileSearchResult,
  ProjectCommandResult,
  ProjectDiff,
  ProjectHealth,
  ServerMessage,
  ThreadMetadata,
  ThreadItem
} from "./types";

type ConnectionState = "idle" | "connecting" | "connected";
type ProfileDraft = Omit<CodexProfile, "id" | "createdAt" | "updatedAt"> & {
  password?: string;
};
type StoredUiState = {
  selectedProfileId?: string;
  activeThreadId?: string;
  search?: string;
};
type StoredActiveTask = {
  profileId: string;
  threadId?: string;
  title: string;
  startedAt: number;
};
type FileSummary = {
  key: string;
  label: string;
  path: string;
  operation?: string;
};
type CommandAction = {
  id: string;
  label: string;
  detail: string;
  icon: ReactNode;
  disabled?: boolean;
  run: () => void;
};
type TaskTokenStats = {
  input?: number;
  output?: number;
  total?: number;
};
type TaskCommandSummary = {
  command: string;
  exitCode?: number | null;
  preview?: string;
};
type TaskSummary = {
  id: string;
  title: string;
  elapsedMs: number;
  tokens: TaskTokenStats | null;
  files: FileSummary[];
  commands: TaskCommandSummary[];
  tests: TaskCommandSummary[];
  completedAt: number;
};
type QueuedTask = {
  id: string;
  text: string;
  createdAt: number;
};
type DiffPanelState = {
  open: boolean;
  loading: boolean;
  files: FileSummary[];
  result?: ProjectDiff;
  error?: string;
};
type HealthPanelState = {
  open: boolean;
  loading: boolean;
  result?: ProjectHealth;
  error?: string;
};
type CommandRunnerState = {
  open: boolean;
  running: boolean;
  command: string;
  result?: ProjectCommandResult;
  error?: string;
};

const uiStateStorageKey = "codex-remote-ui-state";
const activeTaskStorageKey = "codex-remote-active-task";
const recentProjectPathsStorageKey = "codex-remote-recent-project-paths";

const defaultUpdateCommand =
  "(set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh) || npm install -g @openai/codex@latest";

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
  notifyOnCompletion: true,
  showDiagnostics: false,
  showTaskTimer: true,
  showTokenUsage: true,
  historyLimit: 80,
  defaultUpdateCommand
};

const emptyDraft: ProfileDraft = {
  name: "",
  mode: "ssh",
  sshTarget: "",
  projectPath: "",
  codexBin: "codex",
  updateCommand: "",
  quickCommands: [],
  approvalPolicy: "never",
  sandboxMode: "danger-full-access"
};

const modelOptions = [
  { value: "", label: "по умолчанию", shortLabel: "модель" },
  { value: "gpt-5.5", label: "GPT-5.5", shortLabel: "5.5" },
  { value: "gpt-5.4", label: "GPT-5.4", shortLabel: "5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini", shortLabel: "5.4 mini" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", shortLabel: "Spark" }
];

const reasoningOptions: Array<{
  value: AppPreferences["reasoningLevel"];
  label: string;
  shortLabel: string;
}> = [
  { value: "low", label: "Низкий", shortLabel: "низкий" },
  { value: "medium", label: "Средний", shortLabel: "средний" },
  { value: "high", label: "Высокий", shortLabel: "высокий" },
  { value: "very-high", label: "Очень высокий", shortLabel: "очень высокий" }
];

const speedOptions: Array<{
  value: AppPreferences["responseSpeed"];
  label: string;
  description: string;
}> = [
  { value: "standard", label: "Стандартно", description: "Обычная скорость" },
  { value: "fast", label: "Быстро", description: "Быстрее, расход выше" }
];

const compactNumber = new Intl.NumberFormat("ru", {
  maximumFractionDigits: 1,
  notation: "compact"
});

function readStoredUiState(): StoredUiState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(uiStateStorageKey);
    return raw ? JSON.parse(raw) as StoredUiState : {};
  } catch {
    return {};
  }
}

function writeStoredUiState(patch: StoredUiState) {
  if (typeof window === "undefined") return;
  const current = readStoredUiState();
  window.localStorage.setItem(
    uiStateStorageKey,
    JSON.stringify({ ...current, ...patch })
  );
}

function readStoredActiveTask(): StoredActiveTask | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(activeTaskStorageKey);
    return raw ? JSON.parse(raw) as StoredActiveTask : null;
  } catch {
    return null;
  }
}

function writeStoredActiveTask(task: StoredActiveTask | null) {
  if (typeof window === "undefined") return;
  if (!task) {
    window.localStorage.removeItem(activeTaskStorageKey);
    return;
  }
  window.localStorage.setItem(activeTaskStorageKey, JSON.stringify(task));
}

function readRecentProjectPaths(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentProjectPathsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

function writeRecentProjectPath(pathValue: string) {
  if (typeof window === "undefined") return;
  const clean = pathValue.trim();
  if (!clean) return;
  const next = [clean, ...readRecentProjectPaths().filter((item) => item !== clean)].slice(0, 8);
  window.localStorage.setItem(recentProjectPathsStorageKey, JSON.stringify(next));
}

const formatDate = (seconds: number) =>
  new Intl.DateTimeFormat("ru", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(seconds * 1000));

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return `${hours}ч ${String(restMinutes).padStart(2, "0")}м`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTokens(stats: TaskTokenStats | null) {
  if (!stats) return "токены: --";
  const total = stats.total ?? ((stats.input ?? 0) + (stats.output ?? 0));
  if (!total) return "токены: --";
  return `токены: ${compactNumber.format(total)}`;
}

function mergeTokenStats(
  current: TaskTokenStats | null,
  next: TaskTokenStats | null
): TaskTokenStats | null {
  if (!next) return current;
  return {
    input: next.input ?? current?.input,
    output: next.output ?? current?.output,
    total: next.total ?? current?.total
  };
}

function numberFromUnknown(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractTokenStats(value: unknown, depth = 0): TaskTokenStats | null {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const record = value as Record<string, unknown>;
  const direct: TaskTokenStats = {
    input:
      numberFromUnknown(record.input_tokens) ??
      numberFromUnknown(record.inputTokens) ??
      numberFromUnknown(record.prompt_tokens) ??
      numberFromUnknown(record.promptTokens),
    output:
      numberFromUnknown(record.output_tokens) ??
      numberFromUnknown(record.outputTokens) ??
      numberFromUnknown(record.completion_tokens) ??
      numberFromUnknown(record.completionTokens),
    total:
      numberFromUnknown(record.total_tokens) ??
      numberFromUnknown(record.totalTokens) ??
      numberFromUnknown(record.tokens)
  };

  if (direct.input || direct.output || direct.total) {
    return direct;
  }

  for (const child of Object.values(record)) {
    const nested = extractTokenStats(child, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function activityLabelForMessage(message?: ChatMessage) {
  if (!message) return "Готовлю задачу";
  if (message.role === "tool") {
    return message.title?.startsWith("Изменения") ? "Обновляю файлы" : "Выполняю команду";
  }
  if (message.title === "План") return "Планирую шаги";
  if (message.role === "assistant") return "Пишу ответ";
  return "Работаю";
}

const titleOf = (thread?: CodexThread | null) =>
  thread?.name || thread?.preview || "Новый чат";

const serverKeyOf = (profile: CodexProfile) =>
  profile.mode === "local" ? "local" : profile.sshTarget;

const serverLabelOf = (profile?: CodexProfile | null) => {
  if (!profile) return "Нет проекта";
  return profile.mode === "local" ? "Этот компьютер" : profile.sshTarget;
};

const basenameOf = (value: string) => {
  const clean = value.replace(/\/+$/, "");
  return clean.split("/").filter(Boolean).pop() || clean || value;
};

const projectTitleOf = (profile?: CodexProfile | null) => {
  if (!profile) return "Проект не выбран";
  const serverLabel = serverLabelOf(profile);
  return profile.name && profile.name !== serverLabel
    ? profile.name
    : basenameOf(profile.projectPath);
};

const statusText: Record<ConnectionState, string> = {
  idle: "Не подключено",
  connecting: "Подключение",
  connected: "Подключено"
};

const messageRoleLabel: Record<ChatMessage["role"], string> = {
  user: "Вы",
  assistant: "Codex",
  tool: "Терминал",
  system: "Система"
};

const messageAvatarLabel: Record<ChatMessage["role"], string> = {
  user: "Вы",
  assistant: "C",
  tool: "$",
  system: "i"
};

function renderInlineText(text: string, keyPrefix: string) {
  return text.split(/(`[^`\n]+`|\[[^\]\n]+\]\([^)]+\))/g).map((part, index) => {
    const key = `${keyPrefix}-inline-${index}`;
    const codeMatch = part.match(/^`([^`]+)`$/);
    if (codeMatch) {
      return (
        <code key={key} className="inline-code">
          {codeMatch[1]}
        </code>
      );
    }

    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <span key={key} className="file-reference" title={linkMatch[2]}>
          {linkMatch[1]}
        </span>
      );
    }

    return part;
  });
}

function renderTextBlocks(message: ChatMessage) {
  if (message.role === "tool") {
    return (
      <pre className={`message-code tool-output ${message.muted ? "muted" : ""}`}>
        {message.text}
      </pre>
    );
  }

  return message.text
    .split("```")
    .map((part, index) => {
      const key = `${message.id}-${index}`;
      if (!part.trim()) return null;

      if (index % 2 === 1) {
        return (
          <pre key={key} className={`message-code ${message.muted ? "muted" : ""}`}>
            {part.trim()}
          </pre>
        );
      }

      return part
        .split(/\n{2,}/)
        .map((paragraph, paragraphIndex) =>
          paragraph.trim() ? (
            <p key={`${key}-${paragraphIndex}`} className={`message-text ${message.muted ? "muted" : ""}`}>
              {renderInlineText(paragraph.trim(), `${key}-${paragraphIndex}`)}
            </p>
          ) : null
        );
    })
    .flat();
}

function itemToMessage(item: ThreadItem): ChatMessage | null {
  if (item.type === "userMessage") {
    const text = (item.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text ? { id: item.id, role: "user", text } : null;
  }

  if (item.type === "agentMessage") {
    return { id: item.id, role: "assistant", text: item.text || "" };
  }

  if (item.type === "plan") {
    return { id: item.id, role: "assistant", title: "План", text: item.text || "" };
  }

  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput?.trim();
    return {
      id: item.id,
      role: "tool",
      title: item.exitCode === null || item.exitCode === undefined ? "Команда" : `Команда · ${item.exitCode}`,
      text: [item.command ?? "", output].filter(Boolean).join("\n\n"),
      muted: !output
    };
  }

  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes
          .map((change) => [change.operation, change.path].filter(Boolean).join(" "))
          .join("\n")
      : "";
    return { id: item.id, role: "tool", title: "Изменения файлов", text: changes || "Файлы изменены" };
  }

  return null;
}

function commandSummaryFromItem(item: ThreadItem): TaskCommandSummary | null {
  if (item.type !== "commandExecution" || !item.command) return null;
  const output = item.aggregatedOutput?.trim() || "";
  return {
    command: item.command,
    exitCode: item.exitCode,
    preview: previewText(output)
  };
}

function fileSummariesFromItem(item: ThreadItem): FileSummary[] {
  if (item.type !== "fileChange" || !Array.isArray(item.changes)) return [];
  return item.changes
    .map((change): FileSummary | null => {
      const filePath = change.path?.trim();
      if (!filePath) return null;
      return {
        key: filePath,
        label: basenameOf(filePath),
        path: filePath,
        operation: change.operation
      };
    })
    .filter((file): file is FileSummary => file !== null);
}

function isTestLikeCommand(command: string) {
  return /\b(test|lint|typecheck|build|pytest|unittest|vitest|jest|tsc)\b/i.test(command);
}

function mergeFiles(left: FileSummary[], right: FileSummary[]) {
  const files = new Map<string, FileSummary>();
  [...left, ...right].forEach((file) => {
    files.set(file.path, file);
  });
  return Array.from(files.values());
}

function defaultQuickCommands(profile?: CodexProfile | null) {
  const commands = ["git status --short"];
  if (profile?.quickCommands?.length) {
    commands.push(...profile.quickCommands);
  } else {
    commands.push("npm test", "npm run build");
  }
  return commands.filter((command, index, list) => list.indexOf(command) === index);
}

function packageScriptCommand(packageManager: string, script: string) {
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "pnpm") return `pnpm ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function threadToMessages(thread: CodexThread | null): ChatMessage[] {
  if (!thread?.turns) return [];
  return thread.turns
    .flatMap((turn) => turn.items)
    .map(itemToMessage)
    .filter((message): message is ChatMessage => Boolean(message));
}

function upsertMessage(
  messages: ChatMessage[],
  next: ChatMessage,
  append = false
) {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) {
    if (next.role === "user") {
      let localDuplicateIndex = -1;
      for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = messages[messageIndex];
        if (
          message.role === "user" &&
          message.id.startsWith("local-") &&
          message.text === next.text
        ) {
          localDuplicateIndex = messageIndex;
          break;
        }
      }
      if (localDuplicateIndex !== -1) {
        const copy = [...messages];
        copy[localDuplicateIndex] = next;
        return copy;
      }
    }
    return [...messages, next];
  }
  const copy = [...messages];
  copy[index] = append
    ? { ...copy[index], text: `${copy[index].text}${next.text}` }
    : { ...copy[index], ...next };
  return copy;
}

function hasThreadMetadata(metadata?: ThreadMetadata): metadata is ThreadMetadata {
  return Boolean(metadata?.pinned || metadata?.title || metadata?.hidden);
}

function displayTitleOf(thread: CodexThread | null | undefined, metadata?: ThreadMetadata) {
  return metadata?.title || titleOf(thread);
}

type MessageDisplayItem =
  | { type: "message"; message: ChatMessage }
  | { type: "steps"; id: string; messages: ChatMessage[] };
type TurnDisplay = {
  id: string;
  user?: ChatMessage;
  items: MessageDisplayItem[];
  files: FileSummary[];
};

function buildStepGroupId(messages: ChatMessage[]) {
  return `steps-${messages[0]?.id ?? "empty"}-${messages[messages.length - 1]?.id ?? "empty"}`;
}

function collapseAssistantSegment(segment: ChatMessage[]): MessageDisplayItem[] {
  if (segment.length <= 1) {
    if (segment[0]?.role === "tool") {
      return [{ type: "steps", id: buildStepGroupId(segment), messages: segment }];
    }
    return segment.map((message): MessageDisplayItem => ({ type: "message", message }));
  }

  let finalAssistantIndex = -1;
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    if (segment[index].role === "assistant" && segment[index].text.trim()) {
      finalAssistantIndex = index;
      break;
    }
  }

  if (finalAssistantIndex === -1) {
    return [{ type: "steps", id: buildStepGroupId(segment), messages: segment }];
  }

  const beforeFinal = segment.slice(0, finalAssistantIndex);
  const finalMessage = segment[finalAssistantIndex];
  const afterFinal = segment.slice(finalAssistantIndex + 1);
  const items: MessageDisplayItem[] = [];

  if (beforeFinal.length > 0) {
    items.push({ type: "steps", id: buildStepGroupId(beforeFinal), messages: beforeFinal });
  }
  items.push({ type: "message", message: finalMessage });
  if (afterFinal.length > 0) {
    items.push({ type: "steps", id: buildStepGroupId(afterFinal), messages: afterFinal });
  }

  return items;
}

function buildMessageDisplay(messages: ChatMessage[]): MessageDisplayItem[] {
  const items: MessageDisplayItem[] = [];
  let assistantSegment: ChatMessage[] = [];

  const flushAssistantSegment = () => {
    if (assistantSegment.length > 0) {
      items.push(...collapseAssistantSegment(assistantSegment));
      assistantSegment = [];
    }
  };

  messages.forEach((message) => {
    if (message.role === "user") {
      flushAssistantSegment();
      items.push({ type: "message", message });
      return;
    }
    assistantSegment.push(message);
  });

  flushAssistantSegment();
  return items;
}

function normalizeFilePath(value: string) {
  return value.trim().replace(/^file:\/\//, "");
}

function isLikelyFilePath(value: string) {
  if (!value || /^https?:\/\//i.test(value)) return false;
  return /[/\\]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value);
}

function extractFileReferences(messages: ChatMessage[]): FileSummary[] {
  const files = new Map<string, FileSummary>();

  const addFile = (path: string, label?: string, operation?: string) => {
    const normalizedPath = normalizeFilePath(path);
    if (!isLikelyFilePath(normalizedPath)) return;
    const key = normalizedPath;
    if (!files.has(key)) {
      files.set(key, {
        key,
        label: label?.trim() || basenameOf(normalizedPath),
        path: normalizedPath,
        operation
      });
    }
  };

  messages
    .filter((message) => message.role !== "user")
    .forEach((message) => {
      if (message.title === "Изменения файлов") {
        message.text.split("\n").forEach((line) => {
          const [operation, ...pathParts] = line.trim().split(/\s+/);
          addFile(pathParts.join(" "), undefined, operation);
        });
      }

      for (const match of message.text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
        addFile(match[2], match[1]);
      }
    });

  return Array.from(files.values()).slice(0, 8);
}

function buildTurnDisplay(messages: ChatMessage[]): TurnDisplay[] {
  const turns: Array<{ id: string; user?: ChatMessage; messages: ChatMessage[] }> = [];
  let current: { id: string; user?: ChatMessage; messages: ChatMessage[] } | null = null;

  messages.forEach((message) => {
    if (message.role === "user") {
      current = { id: `turn-${message.id}`, user: message, messages: [] };
      turns.push(current);
      return;
    }

    if (!current) {
      current = { id: `turn-orphan-${message.id}`, messages: [] };
      turns.push(current);
    }
    current.messages.push(message);
  });

  return turns.map((turn) => ({
    id: turn.id,
    user: turn.user,
    items: buildMessageDisplay(turn.messages),
    files: extractFileReferences(turn.messages)
  }));
}

function previewText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized;
}

function stepLabelOf(message: ChatMessage) {
  if (message.title?.startsWith("Команда")) return "Команда";
  if (message.title === "Изменения файлов") return "Файлы";
  if (message.title === "План") return "План";
  return message.title || messageRoleLabel[message.role];
}

function stepPreviewOf(message: ChatMessage) {
  if (message.title?.startsWith("Команда")) {
    const [command, ...output] = message.text.split(/\n{2,}/);
    const outputPreview = previewText(output.join(" "));
    return outputPreview ? `${command} · ${outputPreview}` : command;
  }
  return previewText(message.text) || "Без текста";
}

function isThreadNotFoundError(value: string) {
  return /thread not found/i.test(value);
}

function friendlyErrorMessage(value: string) {
  if (isThreadNotFoundError(value)) {
    return "Codex app-server не вернул этот чат. История могла переехать, быть архивирована или не попасть в текущую папку проекта.";
  }
  if (/Codex CLI не найден/i.test(value)) {
    return value;
  }
  if (/Connect to a profile first/i.test(value)) {
    return "Сначала подключитесь к проекту.";
  }
  return value;
}

export default function App() {
  const initialUiStateRef = useRef(readStoredUiState());
  const [profiles, setProfiles] = useState<CodexProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [codexStatus, setCodexStatus] = useState("");
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [activeThread, setActiveThread] = useState<CodexThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState(initialUiStateRef.current.search || "");
  const [isProfileOpen, setProfileOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CodexProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft);
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null);
  const [directoryError, setDirectoryError] = useState("");
  const [isDirectoryLoading, setDirectoryLoading] = useState(false);
  const [sessionPasswords, setSessionPasswords] = useState<Record<string, string>>({});
  const [threadMetadata, setThreadMetadata] = useState<Record<string, ThreadMetadata>>({});
  const [preferences, setPreferences] = useState<AppPreferences>(defaultPreferences);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [cliStatus, setCliStatus] = useState<CodexCliStatus | null>(null);
  const [cliProfileId, setCliProfileId] = useState("");
  const [cliPhase, setCliPhase] = useState<"idle" | "checking" | "checked" | "updating" | "updated">("idle");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [isBusy, setBusy] = useState(false);
  const [taskStartedAt, setTaskStartedAt] = useState<number | null>(null);
  const [taskCompletedAt, setTaskCompletedAt] = useState<number | null>(null);
  const [taskNow, setTaskNow] = useState(Date.now());
  const [taskActivity, setTaskActivity] = useState("Готовлю задачу");
  const [taskTokens, setTaskTokens] = useState<TaskTokenStats | null>(null);
  const [loadingThreadId, setLoadingThreadId] = useState("");
  const [openStepGroups, setOpenStepGroups] = useState<Record<string, boolean>>({});
  const [threadMenu, setThreadMenu] = useState<{
    thread: CodexThread;
    x: number;
    y: number;
  } | null>(null);
  const [isComposerMenuOpen, setComposerMenuOpen] = useState(false);
  const [openComposerSubmenu, setOpenComposerSubmenu] = useState<"model" | "speed" | null>(null);
  const [renamingThread, setRenamingThread] = useState<CodexThread | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingThread, setDeletingThread] = useState<CodexThread | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState("");
  const [isCommandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [isSettingsClosing, setSettingsClosing] = useState(false);
  const [taskQueue, setTaskQueue] = useState<QueuedTask[]>([]);
  const [lastTaskSummary, setLastTaskSummary] = useState<TaskSummary | null>(null);
  const [diffPanel, setDiffPanel] = useState<DiffPanelState>({
    open: false,
    loading: false,
    files: []
  });
  const [healthPanel, setHealthPanel] = useState<HealthPanelState>({
    open: false,
    loading: false
  });
  const [commandRunner, setCommandRunner] = useState<CommandRunnerState>({
    open: false,
    running: false,
    command: ""
  });
  const [isJournalOpen, setJournalOpen] = useState(false);
  const [fileMentionQuery, setFileMentionQuery] = useState("");
  const [fileMentionResults, setFileMentionResults] = useState<FileSearchResult[]>([]);
  const [isFileMentionLoading, setFileMentionLoading] = useState(false);
  const [recoveryTask, setRecoveryTask] = useState<StoredActiveTask | null>(() => readStoredActiveTask());
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [isReconnectPaused, setReconnectPaused] = useState(false);
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>(() => readRecentProjectPaths());

  const wsRef = useRef<WebSocket | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const preferencesRef = useRef(preferences);
  const sessionPasswordsRef = useRef(sessionPasswords);
  const searchRef = useRef(search);
  const didRestoreThreadRef = useRef(false);
  const settingsVisibleRef = useRef(false);
  const settingsCloseTimerRef = useRef<number | null>(null);
  const selectedProfileIdRef = useRef("");
  const selectedProfileRef = useRef<CodexProfile | null>(null);
  const activeThreadRef = useRef<CodexThread | null>(null);
  const connectionRef = useRef<ConnectionState>("idle");
  const manualDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const taskQueueRef = useRef<QueuedTask[]>([]);
  const taskStartedAtRef = useRef<number | null>(null);
  const taskTokensRef = useRef<TaskTokenStats | null>(null);
  const taskCommandsRef = useRef<TaskCommandSummary[]>([]);
  const taskFilesRef = useRef<FileSummary[]>([]);
  const fileMentionTimerRef = useRef<number | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId]
  );

  useEffect(() => {
    selectedProfileIdRef.current = selectedProfileId;
  }, [selectedProfileId]);

  useEffect(() => {
    selectedProfileRef.current = selectedProfile ?? null;
  }, [selectedProfile]);

  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    taskQueueRef.current = taskQueue;
  }, [taskQueue]);

  useEffect(() => {
    taskStartedAtRef.current = taskStartedAt;
  }, [taskStartedAt]);

  useEffect(() => {
    taskTokensRef.current = taskTokens;
  }, [taskTokens]);

  const projectGroups = useMemo(() => {
    const groups = new Map<string, { label: string; profiles: CodexProfile[] }>();
    profiles.forEach((profile) => {
      const key = serverKeyOf(profile);
      const current = groups.get(key) ?? { label: serverLabelOf(profile), profiles: [] };
      current.profiles.push(profile);
      groups.set(key, current);
    });
    return Array.from(groups.entries()).map(([key, group]) => ({
      key,
      label: group.label,
      profiles: group.profiles
    }));
  }, [profiles]);

  const visibleThreads = useMemo(
    () => threads.filter((thread) => !threadMetadata[thread.id]?.hidden),
    [threads, threadMetadata]
  );

  const sortedThreads = useMemo(
    () =>
      [...visibleThreads].sort((left, right) => {
        const leftPinned = threadMetadata[left.id]?.pinned ? 1 : 0;
        const rightPinned = threadMetadata[right.id]?.pinned ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        return right.updatedAt - left.updatedAt;
      }),
    [visibleThreads, threadMetadata]
  );

  const pinnedThreads = useMemo(
    () => sortedThreads.filter((thread) => threadMetadata[thread.id]?.pinned),
    [sortedThreads, threadMetadata]
  );

  const recentThreads = useMemo(
    () => sortedThreads.filter((thread) => !threadMetadata[thread.id]?.pinned),
    [sortedThreads, threadMetadata]
  );

  const turnDisplay = useMemo(() => buildTurnDisplay(messages), [messages]);

  const activeThreadTitle = displayTitleOf(
    activeThread,
    activeThread ? threadMetadata[activeThread.id] : undefined
  );
  const selectedModelValue = selectedProfile?.model ?? "";
  const selectedModelOption = modelOptions.find((option) => option.value === selectedModelValue);
  const selectedModelLabel = selectedModelValue
    ? selectedModelOption?.shortLabel || selectedModelValue.replace(/^gpt-/, "")
    : "";
  const selectedReasoningOption = reasoningOptions.find(
    (option) => option.value === preferences.reasoningLevel
  );
  const selectedReasoningLabel = selectedReasoningOption?.label || "Рассуждение";
  const selectedSpeedLabel =
    speedOptions.find((option) => option.value === preferences.responseSpeed)?.label ||
    "скорость";
  const selectedCliStatus = cliProfileId === selectedProfileId ? cliStatus : null;
  const showFinishedTaskStatus =
    Boolean(taskCompletedAt) && taskNow - (taskCompletedAt ?? 0) < 12_000;
  const showTaskStatus = isBusy || showFinishedTaskStatus;
  const taskElapsedMs = taskStartedAt
    ? (taskCompletedAt && !isBusy ? taskCompletedAt : taskNow) - taskStartedAt
    : 0;
  const taskStatusLabel = isBusy ? taskActivity : "Готово";
  const taskTokenLabel = formatTokens(taskTokens);

  useEffect(() => {
    void loadProfiles();
    void loadPreferences();
    void loadThreadMetadata();
  }, []);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    settingsVisibleRef.current = isSettingsOpen;
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isBusy && !taskCompletedAt) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setTaskNow(now);
      if (!isBusy && taskCompletedAt && now - taskCompletedAt >= 12_000) {
        setTaskCompletedAt(null);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isBusy, taskCompletedAt]);

  useEffect(() => {
    return () => {
      if (settingsCloseTimerRef.current) {
        window.clearTimeout(settingsCloseTimerRef.current);
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (fileMentionTimerRef.current) {
        window.clearTimeout(fileMentionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    sessionPasswordsRef.current = sessionPasswords;
  }, [sessionPasswords]);

  useEffect(() => {
    searchRef.current = search;
    writeStoredUiState({ search });
  }, [search]);

  useEffect(() => {
    if (selectedProfileId) {
      writeStoredUiState({ selectedProfileId });
    }
  }, [selectedProfileId]);

  useEffect(() => {
    if (activeThread?.id) {
      writeStoredUiState({ activeThreadId: activeThread.id });
    }
  }, [activeThread?.id]);

  useEffect(() => {
    const match = input.match(/(?:^|\s)@([^\s@]{1,80})$/);
    const query = match?.[1] ?? "";
    setFileMentionQuery(query);

    if (fileMentionTimerRef.current) {
      window.clearTimeout(fileMentionTimerRef.current);
      fileMentionTimerRef.current = null;
    }

    if (!query || connection !== "connected" || !selectedProfileId) {
      setFileMentionResults([]);
      setFileMentionLoading(false);
      return;
    }

    setFileMentionLoading(true);
    fileMentionTimerRef.current = window.setTimeout(() => {
      void searchFilesForMention(query);
    }, 180);
  }, [connection, input, selectedProfileId]);

  useEffect(() => {
    const closeTransientMenus = () => {
      setThreadMenu(null);
      setComposerMenuOpen(false);
      setOpenComposerSubmenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        closeTransientMenus();
        setCommandQuery("");
        setCommandOpen(true);
        return;
      }
      if (event.key === "Escape") {
        closeTransientMenus();
        setCommandOpen(false);
        closeSettings();
      }
    };

    window.addEventListener("click", closeTransientMenus);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeTransientMenus);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = socket;

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      handleServerMessage(message);
    };

    socket.onclose = () => {
      setConnection("idle");
      setCodexStatus("connection closed");
    };

    return () => socket.close();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, messages.map((message) => message.text.length).join(":")]);

  useEffect(() => {
    if (
      connection !== "connected" ||
      didRestoreThreadRef.current ||
      activeThread ||
      loadingThreadId
    ) {
      return;
    }

    const storedThreadId = readStoredUiState().activeThreadId;
    const thread = storedThreadId
      ? threads.find((item) => item.id === storedThreadId)
      : undefined;
    if (!thread) return;

    didRestoreThreadRef.current = true;
    selectThread(thread);
  }, [activeThread, connection, loadingThreadId, threads]);

  async function loadProfiles() {
    const response = await fetch("/api/profiles");
    const data = (await response.json()) as { profiles: CodexProfile[] };
    setProfiles(data.profiles);
    setSelectedProfileId((current) => {
      if (current && data.profiles.some((profile) => profile.id === current)) {
        return current;
      }
      const storedProfileId = initialUiStateRef.current.selectedProfileId;
      if (storedProfileId && data.profiles.some((profile) => profile.id === storedProfileId)) {
        return storedProfileId;
      }
      return data.profiles[0]?.id || "";
    });
  }

  async function loadPreferences() {
    const response = await fetch("/api/preferences");
    const data = (await response.json()) as { preferences: AppPreferences };
    setPreferences({ ...defaultPreferences, ...data.preferences });
  }

  async function loadThreadMetadata() {
    const response = await fetch("/api/thread-metadata");
    const data = (await response.json()) as { threadMetadata: Record<string, ThreadMetadata> };
    setThreadMetadata(data.threadMetadata || {});
  }

  async function updatePreferences(patch: Partial<AppPreferences>) {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    const response = await fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const data = (await response.json()) as { preferences?: AppPreferences };
    if (data.preferences) {
      setPreferences({ ...defaultPreferences, ...data.preferences });
    }
  }

  function resetDirectoryBrowser() {
    setDirectoryListing(null);
    setDirectoryError("");
    setDirectoryLoading(false);
  }

  function openSettings() {
    if (settingsCloseTimerRef.current) {
      window.clearTimeout(settingsCloseTimerRef.current);
      settingsCloseTimerRef.current = null;
    }
    settingsVisibleRef.current = true;
    setSettingsClosing(false);
    setSettingsOpen(true);
  }

  function closeSettings() {
    if (!settingsVisibleRef.current) {
      return;
    }

    if (!preferencesRef.current.animations) {
      settingsVisibleRef.current = false;
      setSettingsClosing(false);
      setSettingsOpen(false);
      return;
    }

    setSettingsClosing(true);
    if (settingsCloseTimerRef.current) {
      window.clearTimeout(settingsCloseTimerRef.current);
    }
    settingsCloseTimerRef.current = window.setTimeout(() => {
      settingsVisibleRef.current = false;
      setSettingsOpen(false);
      setSettingsClosing(false);
      settingsCloseTimerRef.current = null;
    }, 260);
  }

  function updateDraft(patch: Partial<ProfileDraft>, resetBrowser = false) {
    setDraft((current) => ({ ...current, ...patch }));
    if (resetBrowser) {
      resetDirectoryBrowser();
    }
  }

  async function loadDirectories(pathOverride?: string) {
    const targetPath = (pathOverride ?? draft.projectPath).trim() ||
      (draft.mode === "local" ? "~" : "/var/www");

    if (draft.mode === "ssh" && !draft.sshTarget.trim()) {
      setDirectoryError("Сначала укажите сервер.");
      return;
    }

    setDirectoryLoading(true);
    setDirectoryError("");

    try {
      const response = await fetch("/api/directories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: draft.mode,
          sshTarget: draft.sshTarget,
          port: draft.port,
          identityFile: draft.identityFile,
          projectPath: draft.projectPath,
          path: targetPath,
          password: draft.password
        })
      });
      const data = (await response.json()) as {
        listing?: DirectoryListing;
        error?: string;
      };
      if (!response.ok || !data.listing) {
        throw new Error(data.error || "Не удалось открыть папку.");
      }
      setDirectoryListing(data.listing);
      setDraft((current) => ({
        ...current,
        name: current.name.trim() ? current.name : basenameOf(data.listing!.currentPath),
        projectPath: data.listing!.currentPath
      }));
    } catch (directoryLoadError) {
      setDirectoryError(
        directoryLoadError instanceof Error
          ? directoryLoadError.message
          : "Не удалось открыть папку."
      );
    } finally {
      setDirectoryLoading(false);
    }
  }

  function send(payload: unknown) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    } else {
      setError("WebSocket не подключен.");
    }
  }

  function addLog(line: string) {
    const stamp = new Intl.DateTimeFormat("ru", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date());
    setLogs((current) => [`${stamp} · ${line}`.trim(), ...current].filter(Boolean).slice(0, 80));
  }

  function projectApiBody(extra: Record<string, unknown> = {}) {
    const profileId = selectedProfileIdRef.current;
    return {
      profileId,
      password: profileId ? sessionPasswordsRef.current[profileId] || undefined : undefined,
      ...extra
    };
  }

  async function searchFilesForMention(query: string) {
    try {
      const response = await fetch("/api/project/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectApiBody({ query }))
      });
      const data = (await response.json()) as { files?: FileSearchResult[]; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Не удалось найти файлы.");
      }
      setFileMentionResults(data.files || []);
    } catch (mentionError) {
      addLog(mentionError instanceof Error ? mentionError.message : "Ошибка поиска файлов.");
      setFileMentionResults([]);
    } finally {
      setFileMentionLoading(false);
    }
  }

  function applyFileMention(file: FileSearchResult) {
    setInput((current) => current.replace(/@([^\s@]{1,80})$/, `@${file.path} `));
    setFileMentionResults([]);
    setFileMentionQuery("");
  }

  async function openProjectDiff(files: FileSummary[] = []) {
    if (!selectedProfileIdRef.current) {
      setProfileOpen(true);
      return;
    }

    const cleanFiles = mergeFiles([], files);
    setDiffPanel({ open: true, loading: true, files: cleanFiles });
    addLog(cleanFiles.length ? `Открываю diff: ${cleanFiles.length} файлов` : "Открываю diff проекта");

    try {
      const response = await fetch("/api/project/diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectApiBody({ files: cleanFiles.map((file) => file.path) }))
      });
      const data = (await response.json()) as { diff?: ProjectDiff; error?: string };
      if (!response.ok || !data.diff) {
        throw new Error(data.error || "Не удалось прочитать diff.");
      }
      setDiffPanel({ open: true, loading: false, files: cleanFiles, result: data.diff });
    } catch (diffError) {
      setDiffPanel({
        open: true,
        loading: false,
        files: cleanFiles,
        error: diffError instanceof Error ? diffError.message : "Не удалось прочитать diff."
      });
    }
  }

  async function openProjectHealth() {
    if (!selectedProfileIdRef.current) {
      setProfileOpen(true);
      return;
    }

    setHealthPanel({ open: true, loading: true });
    addLog("Проверяю проект");

    try {
      const response = await fetch("/api/project/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectApiBody())
      });
      const data = (await response.json()) as { health?: ProjectHealth; error?: string };
      if (!response.ok || !data.health) {
        throw new Error(data.error || "Не удалось проверить проект.");
      }
      setHealthPanel({ open: true, loading: false, result: data.health });
    } catch (healthError) {
      setHealthPanel({
        open: true,
        loading: false,
        error: healthError instanceof Error ? healthError.message : "Не удалось проверить проект."
      });
    }
  }

  function openProjectCommands(command = "") {
    setCommandRunner({
      open: true,
      running: false,
      command: command || defaultQuickCommands(selectedProfileRef.current)[0] || "git status --short"
    });
  }

  async function runProjectCommand(command = commandRunner.command) {
    const clean = command.trim();
    if (!clean) {
      setCommandRunner((current) => ({ ...current, error: "Команда пустая." }));
      return;
    }

    setCommandRunner((current) => ({
      ...current,
      command: clean,
      running: true,
      result: undefined,
      error: undefined
    }));
    addLog(`Команда проекта: ${clean}`);

    try {
      const response = await fetch("/api/project/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projectApiBody({ command: clean }))
      });
      const data = (await response.json()) as { result?: ProjectCommandResult; error?: string };
      if (!response.ok || !data.result) {
        throw new Error(data.error || "Команда не выполнилась.");
      }
      setCommandRunner((current) => ({ ...current, running: false, result: data.result }));
    } catch (commandError) {
      setCommandRunner((current) => ({
        ...current,
        running: false,
        error: commandError instanceof Error ? commandError.message : "Команда не выполнилась."
      }));
    }
  }

  function resetTaskCollectors() {
    taskCommandsRef.current = [];
    taskFilesRef.current = [];
    setLastTaskSummary(null);
  }

  function startTask(text: string) {
    const clean = text.trim();
    if (!clean || connectionRef.current !== "connected") return;

    const profileId = selectedProfileIdRef.current;
    const threadId = activeThreadRef.current?.id;
    resetTaskCollectors();
    setError("");
    setBusy(true);
    const startedAt = Date.now();
    setTaskStartedAt(startedAt);
    taskStartedAtRef.current = startedAt;
    setTaskCompletedAt(null);
    setTaskActivity("Отправляю задачу");
    setTaskTokens(null);
    taskTokensRef.current = null;
    writeStoredActiveTask({
      profileId,
      threadId,
      title: previewText(clean),
      startedAt
    });
    setRecoveryTask(readStoredActiveTask());
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: "user", text: clean }
    ]);
    send({
      type: "sendMessage",
      threadId,
      text: clean
    });
  }

  function enqueueTask(text: string) {
    const clean = text.trim();
    if (!clean) return;
    setTaskQueue((current) => [
      ...current,
      { id: `queue-${Date.now()}-${current.length}`, text: clean, createdAt: Date.now() }
    ]);
    addLog("Задача добавлена в очередь");
  }

  function runNextQueuedTask() {
    const [next] = taskQueueRef.current;
    if (!next) return;
    setTaskQueue((current) => current.filter((item) => item.id !== next.id));
    startTask(next.text);
  }

  function scheduleReconnect(reason: string) {
    if (manualDisconnectRef.current || isReconnectPaused) return;
    const profileId = selectedProfileIdRef.current;
    if (!profileId || reconnectAttempt >= 5) return;
    const nextAttempt = reconnectAttempt + 1;
    setReconnectAttempt(nextAttempt);
    addLog(`${reason}. Переподключение ${nextAttempt}/5`);
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
    }
    reconnectTimerRef.current = window.setTimeout(() => {
      connectProject(profileId);
    }, Math.min(1000 + nextAttempt * 1000, 6000));
  }

  function stopReconnect() {
    setReconnectPaused(true);
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function handleServerMessage(message: ServerMessage) {
    if (message.type === "connection") {
      const previousConnection = connectionRef.current;
      setConnection(message.status);
      connectionRef.current = message.status;
      setCodexStatus(message.status);
      addLog(
        message.status === "connected"
          ? `Подключено: ${message.profile ? projectTitleOf(message.profile) : "проект"}`
          : message.status === "connecting"
            ? "Подключение к проекту"
            : "Соединение закрыто"
      );
      if (message.status !== "connected") {
        setLoadingThreadId("");
      }
      if (message.status === "connected") {
        manualDisconnectRef.current = false;
        setReconnectAttempt(0);
        setReconnectPaused(false);
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      }
      if (
        message.status === "idle" &&
        previousConnection === "connected" &&
        !manualDisconnectRef.current
      ) {
        scheduleReconnect("Соединение потеряно");
      }
      if (
        message.status === "connected" &&
        message.profile?.id &&
        preferencesRef.current.autoCheckUpdates
      ) {
        send({
          type: "checkCodexCli",
          profileId: message.profile.id,
          password: sessionPasswordsRef.current[message.profile.id] || undefined
        });
      }
      return;
    }

    if (message.type === "codexStatus") {
      setCodexStatus(message.status);
      return;
    }

    if (message.type === "codexCli") {
      setCliPhase(message.phase);
      if (message.phase === "checked") addLog("Проверка Codex CLI завершена");
      if (message.phase === "updated") addLog("Установка/обновление Codex CLI завершено");
      if (message.profileId) {
        setCliProfileId(message.profileId);
      }
      if (message.result) {
        setCliStatus(message.result);
      }
      return;
    }

    if (message.type === "threads") {
      setThreads(message.result.data || []);
      addLog(`Прочитано чатов: ${message.result.data?.length ?? 0}`);
      return;
    }

    if (message.type === "thread") {
      setActiveThread(message.result.thread);
      setMessages(threadToMessages(message.result.thread));
      setLoadingThreadId("");
      setOpenStepGroups({});
      setBusy(false);
      addLog(`Открыт чат: ${displayTitleOf(message.result.thread, threadMetadata[message.result.thread.id])}`);
      setThreads((current) => {
        const exists = current.some((thread) => thread.id === message.result.thread.id);
        if (exists) {
          return current.map((thread) =>
            thread.id === message.result.thread.id
              ? { ...thread, ...message.result.thread, turns: thread.turns }
              : thread
          );
        }
        return [message.result.thread, ...current];
      });
      return;
    }

    if (message.type === "threadDeleted") {
      setPendingDeleteThreadId((current) =>
        current === message.threadId ? "" : current
      );
      if (message.archiveError) {
        addLog(`Чат удален локально. Codex: ${message.archiveError}`);
      } else {
        addLog(message.archived ? "Чат архивирован" : "Чат удален");
      }
      return;
    }

    if (message.type === "turn") {
      setBusy(true);
      return;
    }

    if (message.type === "log") {
      addLog(message.line.trim());
      return;
    }

    if (message.type === "error") {
      setError(friendlyErrorMessage(message.message));
      if (/Codex CLI не найден|Profile not found|auth/i.test(message.message)) {
        setReconnectPaused(true);
      }
      addLog(`Ошибка: ${message.message}`);
      setBusy(false);
      setLoadingThreadId("");
      return;
    }

    if (message.type === "notification") {
      handleNotification(message.message.method, message.message.params);
    }
  }

  function notifyCompletion() {
    if (!preferencesRef.current.notifyOnCompletion || typeof window === "undefined") return;
    if (!("Notification" in window)) return;

    const title = "Codex закончил задачу";
    const body = activeThreadTitle || selectedProfile?.projectPath || "Ответ готов";
    const show = () => new Notification(title, { body });

    if (Notification.permission === "granted") {
      show();
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") show();
      });
    }
  }

  function handleNotification(method: string, params: any) {
    if (method === "thread/started" && params.thread) {
      setActiveThread(params.thread);
      setThreads((current) => [params.thread, ...current.filter((thread) => thread.id !== params.thread.id)]);
    }

    if (method === "turn/started") {
      setBusy(true);
      setTaskStartedAt((current) => current ?? Date.now());
      taskStartedAtRef.current = taskStartedAtRef.current ?? Date.now();
      setTaskCompletedAt(null);
      setTaskActivity("Начинаю задачу");
      setTaskTokens((current) => mergeTokenStats(current, extractTokenStats(params)));
      resetTaskCollectors();
    }

    if (method === "item/started" && params.item) {
      const next = itemToMessage(params.item);
      if (next) {
        setTaskActivity(activityLabelForMessage(next));
        setMessages((current) => upsertMessage(current, next));
      }
      setTaskTokens((current) => mergeTokenStats(current, extractTokenStats(params)));
    }

    if (method === "item/agentMessage/delta") {
      setTaskActivity("Пишу ответ");
      setMessages((current) =>
        upsertMessage(
          current,
          { id: params.itemId, role: "assistant", text: params.delta || "" },
          true
        )
      );
    }

    if (method === "item/plan/delta") {
      setTaskActivity("Планирую шаги");
      setMessages((current) =>
        upsertMessage(
          current,
          { id: params.itemId, role: "assistant", title: "План", text: params.delta || "" },
          true
        )
      );
    }

    if (method === "item/commandExecution/outputDelta") {
      setTaskActivity("Выполняю команду");
      setMessages((current) =>
        upsertMessage(
          current,
          { id: params.itemId, role: "tool", title: "Команда", text: params.delta || "" },
          true
        )
      );
    }

    if (method === "item/completed" && params.item) {
      const next = itemToMessage(params.item);
      if (next) {
        setTaskActivity(activityLabelForMessage(next));
        setMessages((current) => upsertMessage(current, next));
      }
      const command = commandSummaryFromItem(params.item);
      if (command) {
        taskCommandsRef.current = [...taskCommandsRef.current, command];
      }
      const files = fileSummariesFromItem(params.item);
      if (files.length > 0) {
        taskFilesRef.current = mergeFiles(taskFilesRef.current, files);
      }
      setTaskTokens((current) => mergeTokenStats(current, extractTokenStats(params)));
    }

    if (method === "turn/completed") {
      const completedAt = Date.now();
      const startedAt = taskStartedAtRef.current ?? completedAt;
      const tokens = mergeTokenStats(taskTokensRef.current, extractTokenStats(params));
      setBusy(false);
      setTaskCompletedAt(completedAt);
      setTaskActivity("Готово");
      setTaskTokens(tokens);
      setLastTaskSummary({
        id: `summary-${completedAt}`,
        title: activeThreadTitle || "Задача",
        elapsedMs: completedAt - startedAt,
        tokens,
        files: taskFilesRef.current,
        commands: taskCommandsRef.current,
        tests: taskCommandsRef.current.filter((command) => isTestLikeCommand(command.command)),
        completedAt
      });
      writeStoredActiveTask(null);
      setRecoveryTask(null);
      addLog("Задача завершена");
      notifyCompletion();
      if (preferencesRef.current.autoRefreshHistory) {
        send({ type: "listThreads", searchTerm: searchRef.current });
      }
      window.setTimeout(runNextQueuedTask, 400);
    }
  }

  function connectProject(profileId = selectedProfileId) {
    if (!profileId) {
      setProfileOpen(true);
      return;
    }
    manualDisconnectRef.current = false;
    setReconnectPaused(false);
    setSelectedProfileId(profileId);
    setError("");
    setMessages([]);
    setActiveThread(null);
    setThreads([]);
    setBusy(false);
    setLoadingThreadId("");
    setOpenStepGroups({});
    didRestoreThreadRef.current = false;
    setConnection("connecting");
    addLog("Подключаюсь к проекту");
    send({
      type: "connect",
      profileId,
      password: sessionPasswords[profileId] || undefined
    });
  }

  function runProject(profileId: string) {
    if (connection === "connecting") return;

    if (profileId === selectedProfileId && connection === "connected") {
      return;
    }

    connectProject(profileId);
  }

  function handleProjectKey(event: KeyboardEvent<HTMLDivElement>, profileId: string) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    runProject(profileId);
  }

  function openThreadContextMenu(event: MouseEvent, thread: CodexThread) {
    event.preventDefault();
    const menuWidth = 220;
    const menuHeight = 286;
    setThreadMenu({
      thread,
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8)
    });
  }

  function toggleComposerMenu(event: MouseEvent) {
    event.stopPropagation();
    setComposerMenuOpen((current) => {
      const nextOpen = !current;
      if (!nextOpen) {
        setOpenComposerSubmenu(null);
      }
      return nextOpen;
    });
  }

  async function updateSelectedModel(model: string) {
    if (!selectedProfile) {
      setProfileOpen(true);
      return;
    }

    const previousProfiles = profiles;
    const nextModel = model || undefined;
    setComposerMenuOpen(false);
    setOpenComposerSubmenu(null);
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === selectedProfile.id
          ? { ...profile, model: nextModel, updatedAt: new Date().toISOString() }
          : profile
      )
    );

    try {
      const response = await fetch(`/api/profiles/${selectedProfile.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: nextModel })
      });
      const data = (await response.json()) as { profile?: CodexProfile; error?: string };
      if (!response.ok || !data.profile) {
        throw new Error(data.error || "Не удалось переключить модель.");
      }
      setProfiles((current) =>
        current.map((profile) => (profile.id === data.profile!.id ? data.profile! : profile))
      );
    } catch (modelError) {
      setProfiles(previousProfiles);
      setError(modelError instanceof Error ? modelError.message : "Не удалось переключить модель.");
    }
  }

  function checkCodexCli() {
    if (!selectedProfileId) {
      setProfileOpen(true);
      return;
    }
    setCliProfileId(selectedProfileId);
    setCliPhase("checking");
    send({
      type: "checkCodexCli",
      profileId: selectedProfileId,
      password: sessionPasswords[selectedProfileId] || undefined
    });
  }

  function updateCodexCli() {
    if (!selectedProfileId) {
      setProfileOpen(true);
      return;
    }
    setCliProfileId(selectedProfileId);
    setCliPhase("updating");
    send({
      type: "updateCodexCli",
      profileId: selectedProfileId,
      password: sessionPasswords[selectedProfileId] || undefined
    });
  }

  function disconnect() {
    manualDisconnectRef.current = true;
    stopReconnect();
    send({ type: "disconnect" });
    setConnection("idle");
    setBusy(false);
    setLoadingThreadId("");
    writeStoredActiveTask(null);
    setRecoveryTask(null);
    addLog("Отключено вручную");
  }

  function selectThread(thread: CodexThread) {
    setActiveThread(thread);
    setMessages([]);
    setLoadingThreadId(thread.id);
    setOpenStepGroups({});
    setTaskCompletedAt(null);
    setLastTaskSummary(null);
    send({ type: "readThread", threadId: thread.id });
  }

  function newThread() {
    setActiveThread(null);
    setMessages([]);
    setLoadingThreadId("");
    setOpenStepGroups({});
    setTaskCompletedAt(null);
    setLastTaskSummary(null);
    send({ type: "newThread" });
  }

  async function togglePin(thread: CodexThread) {
    const pinned = !threadMetadata[thread.id]?.pinned;
    const previous = threadMetadata;
    setThreadMetadata((current) => {
      const next = { ...current };
      const metadata = { ...current[thread.id], pinned: pinned || undefined };
      if (pinned) {
        next[thread.id] = metadata;
      } else if (hasThreadMetadata(metadata)) {
        next[thread.id] = metadata;
      } else {
        delete next[thread.id];
      }
      return next;
    });

    try {
      const response = await fetch(`/api/thread-metadata/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned })
      });
      const data = (await response.json()) as { metadata?: ThreadMetadata; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Не удалось закрепить чат.");
      }
      setThreadMetadata((current) => {
        const next = { ...current };
        if (hasThreadMetadata(data.metadata)) {
          next[thread.id] = data.metadata;
        } else {
          delete next[thread.id];
        }
        return next;
      });
    } catch (pinError) {
      setThreadMetadata(previous);
      setError(pinError instanceof Error ? pinError.message : "Не удалось закрепить чат.");
    }
  }

  function openRenameThread(thread: CodexThread) {
    setRenamingThread(thread);
    setRenameValue(displayTitleOf(thread, threadMetadata[thread.id]));
  }

  async function saveThreadTitle(event: FormEvent) {
    event.preventDefault();
    if (!renamingThread) return;

    const nextTitle = renameValue.trim();
    if (!nextTitle) {
      setError("Название чата не может быть пустым.");
      return;
    }

    const threadId = renamingThread.id;
    const previous = threadMetadata;
    setRenamingThread(null);
    setThreadMetadata((current) => ({
      ...current,
      [threadId]: { ...current[threadId], title: nextTitle }
    }));

    try {
      const response = await fetch(`/api/thread-metadata/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle })
      });
      const data = (await response.json()) as { metadata?: ThreadMetadata; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Не удалось переименовать чат.");
      }
      setThreadMetadata((current) => {
        const next = { ...current };
        if (hasThreadMetadata(data.metadata)) {
          next[threadId] = data.metadata;
        } else {
          delete next[threadId];
        }
        return next;
      });
    } catch (renameError) {
      setThreadMetadata(previous);
      setError(renameError instanceof Error ? renameError.message : "Не удалось переименовать чат.");
    }
  }

  async function confirmDeleteThread() {
    if (!deletingThread) return;

    const thread = deletingThread;
    const previousThreads = threads;
    const previousMetadata = threadMetadata;
    setDeletingThread(null);
    setPendingDeleteThreadId(thread.id);
    setThreads((current) => current.filter((item) => item.id !== thread.id));
    setThreadMetadata((current) => ({
      ...current,
      [thread.id]: { ...current[thread.id], pinned: undefined, hidden: true }
    }));
    if (activeThread?.id === thread.id) {
      setActiveThread(null);
      setMessages([]);
      setLoadingThreadId("");
      setOpenStepGroups({});
    }

    try {
      const response = await fetch(`/api/thread-metadata/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true, pinned: false })
      });
      const data = (await response.json()) as { metadata?: ThreadMetadata; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Не удалось удалить чат.");
      }
      send({ type: "deleteThread", threadId: thread.id });
    } catch (deleteError) {
      setPendingDeleteThreadId("");
      setThreads(previousThreads);
      setThreadMetadata(previousMetadata);
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить чат.");
    }
  }

  async function hideActiveThreadLocally() {
    if (!activeThread) return;

    const thread = activeThread;
    const previousThreads = threads;
    const previousMetadata = threadMetadata;
    setThreads((current) => current.filter((item) => item.id !== thread.id));
    setThreadMetadata((current) => ({
      ...current,
      [thread.id]: { ...current[thread.id], pinned: undefined, hidden: true }
    }));
    setActiveThread(null);
    setMessages([]);
    setLoadingThreadId("");
    setOpenStepGroups({});
    setError("");

    try {
      const response = await fetch(`/api/thread-metadata/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true, pinned: false })
      });
      const data = (await response.json()) as { metadata?: ThreadMetadata; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Не удалось скрыть чат.");
      }
    } catch (hideError) {
      setThreads(previousThreads);
      setThreadMetadata(previousMetadata);
      setActiveThread(thread);
      setError(hideError instanceof Error ? hideError.message : "Не удалось скрыть чат.");
    }
  }

  function submitTaskOrQueue(text: string) {
    if (isBusy) {
      enqueueTask(text);
      return;
    }
    startTask(text);
  }

  function archiveActiveThread() {
    if (!activeThread) return;
    send({ type: "archiveThread", threadId: activeThread.id });
    setThreads((current) => current.filter((thread) => thread.id !== activeThread.id));
    setActiveThread(null);
    setMessages([]);
  }

  function forkActiveThread() {
    if (!activeThread) return;
    send({ type: "forkThread", threadId: activeThread.id });
    addLog("Создаю форк чата");
  }

  function compactActiveThread() {
    if (!activeThread) return;
    send({ type: "compactThread", threadId: activeThread.id });
    setBusy(true);
    setTaskActivity("Сжимаю контекст");
    addLog("Сжимаю контекст чата");
  }

  function handleSlashInput(text: string) {
    if (!text.startsWith("/")) return false;
    const [rawCommand, ...rest] = text.slice(1).trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = rest.join(" ").trim();

    if (!command) return false;

    switch (command) {
      case "diff":
        void openProjectDiff();
        return true;
      case "check":
      case "health":
      case "status":
        void openProjectHealth();
        return true;
      case "commands":
      case "cmd":
        openProjectCommands(argument);
        return true;
      case "journal":
      case "logs":
        setJournalOpen(true);
        return true;
      case "settings":
        openSettings();
        return true;
      case "new":
      case "clear":
        newThread();
        return true;
      case "fork":
        forkActiveThread();
        return true;
      case "archive":
        archiveActiveThread();
        return true;
      case "delete":
        if (activeThread) setDeletingThread(activeThread);
        return true;
      case "compact":
        compactActiveThread();
        return true;
      case "model":
        setComposerMenuOpen(true);
        setOpenComposerSubmenu("model");
        return true;
      case "permissions":
        if (selectedProfile) openProfile(selectedProfile);
        return true;
      case "mention":
        setInput("@");
        return true;
      case "review":
        submitTaskOrQueue(argument || "Проведи code review текущих изменений. Покажи только важные баги, риски и недостающие проверки.");
        return true;
      case "doctor":
        openProjectCommands(`${selectedProfile?.codexBin || "codex"} doctor --summary --ascii`);
        return true;
      case "features":
        openProjectCommands(`${selectedProfile?.codexBin || "codex"} features list`);
        return true;
      case "mcp":
        submitTaskOrQueue("Покажи доступные MCP серверы и инструменты для этой сессии. Если чего-то не хватает, предложи настройку.");
        return true;
      case "plugins":
        submitTaskOrQueue("Покажи установленные плагины Codex и что из них полезно для текущего проекта.");
        return true;
      case "skills":
        submitTaskOrQueue("Покажи релевантные skills Codex для текущей задачи и как их лучше использовать.");
        return true;
      case "goal":
        submitTaskOrQueue(argument ? `/goal ${argument}` : "Покажи текущую цель задачи и прогресс.");
        return true;
      default:
        return false;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || connection !== "connected") return;

    setInput("");
    if (handleSlashInput(text)) {
      return;
    }

    if (isBusy) {
      enqueueTask(text);
      return;
    }

    startTask(text);
  }

  function openProfile(profile?: CodexProfile, template?: CodexProfile) {
    setEditingProfile(profile ?? null);
    const nextDraft = profile
      ? {
          name: profile.name,
          mode: profile.mode,
          sshTarget: profile.sshTarget,
          port: profile.port,
          identityFile: profile.identityFile,
          projectPath: profile.projectPath,
          codexBin: profile.codexBin,
          model: profile.model,
          updateCommand: profile.updateCommand,
          quickCommands: profile.quickCommands ?? [],
          approvalPolicy: profile.approvalPolicy,
          sandboxMode: profile.sandboxMode,
          password: sessionPasswords[profile.id] ?? ""
        }
      : template
        ? {
            ...emptyDraft,
            mode: template.mode,
            sshTarget: template.sshTarget,
            port: template.port,
            identityFile: template.identityFile,
            projectPath: "",
            codexBin: template.codexBin,
            model: template.model,
            updateCommand: template.updateCommand,
            quickCommands: template.quickCommands ?? [],
            approvalPolicy: template.approvalPolicy,
            sandboxMode: template.sandboxMode,
            password: sessionPasswords[template.id] ?? ""
          }
        : emptyDraft;
    setDraft(nextDraft);
    resetDirectoryBrowser();
    setProfileOpen(true);
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const { password, ...rawProfilePayload } = draft;
    const profilePayload = {
      ...rawProfilePayload,
      name: rawProfilePayload.name.trim() || basenameOf(rawProfilePayload.projectPath.trim())
    };
    const url = editingProfile ? `/api/profiles/${editingProfile.id}` : "/api/profiles";
    const response = await fetch(url, {
      method: editingProfile ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profilePayload)
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Не удалось сохранить профиль.");
      return;
    }
    await loadProfiles();
    setSelectedProfileId(data.profile.id);
    writeRecentProjectPath(data.profile.projectPath);
    setRecentProjectPaths(readRecentProjectPaths());
    if (password) {
      setSessionPasswords((current) => ({
        ...current,
        [data.profile.id]: password
      }));
    }
    setProfileOpen(false);
  }

  async function removeProfile(profile: CodexProfile) {
    await fetch(`/api/profiles/${profile.id}`, { method: "DELETE" });
    if (selectedProfileId === profile.id) {
      setSelectedProfileId("");
      disconnect();
    }
    await loadProfiles();
  }

  function refreshThreads(nextSearch = search) {
    setSearch(nextSearch);
    send({ type: "listThreads", searchTerm: nextSearch });
  }

  const quickCommands = useMemo(() => defaultQuickCommands(selectedProfile), [selectedProfile]);
  const slashCommandActions = useMemo(
    () => [
      { command: "/diff", label: "Показать изменения" },
      { command: "/status", label: "Проверить проект" },
      { command: "/review", label: "Code review изменений" },
      { command: "/compact", label: "Сжать контекст" },
      { command: "/fork", label: "Сделать копию чата" },
      { command: "/archive", label: "Архивировать чат" },
      { command: "/delete", label: "Удалить чат" },
      { command: "/new", label: "Новый чат" },
      { command: "/commands", label: "Команды проекта" },
      { command: "/doctor", label: "Диагностика Codex" },
      { command: "/features", label: "Флаги Codex" },
      { command: "/mention", label: "Упомянуть файл" },
      { command: "/model", label: "Модель и рассуждение" },
      { command: "/permissions", label: "Доступ и подтверждения" },
      { command: "/mcp", label: "MCP" },
      { command: "/plugins", label: "Плагины" },
      { command: "/skills", label: "Skills" },
      { command: "/journal", label: "Журнал событий" }
    ],
    []
  );
  const slashQuery = input.startsWith("/") ? input.slice(1).trim().toLowerCase() : "";
  const visibleSlashCommands = input.startsWith("/")
    ? slashCommandActions
        .filter((item) => `${item.command} ${item.label}`.toLowerCase().includes(slashQuery))
        .slice(0, 8)
    : [];
  const canSend = connection === "connected" && input.trim().length > 0;
  const sendButtonLabel = isBusy ? "В очередь" : "Отправить";
  const isCliWorking = cliPhase === "checking" || cliPhase === "updating";
  const isCodexMissing = Boolean(selectedCliStatus?.missing);
  const cliVersionLabel = isCodexMissing
    ? "не установлен"
    : selectedCliStatus?.installed || "не проверено";
  const canInstallOrUpdateCodex =
    Boolean(selectedProfileId) &&
    !isCliWorking &&
    Boolean(isCodexMissing || selectedCliStatus?.updateAvailable);
  const codexActionLabel = isCodexMissing ? "Установить" : "Обновить";
  const showCodexBootstrap =
    Boolean(selectedProfile) &&
    connection !== "connected" &&
    Boolean(selectedCliStatus?.missing);
  const threadNotFoundRecovery = isThreadNotFoundError(error);
  const rootClassName = [
    "app-shell",
    `theme-${preferences.theme}`,
    `concept-${preferences.interfaceStyle}`,
    preferences.animations ? "motion-on" : "motion-off",
    preferences.compactMode ? "compact-mode" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const portalClassName = rootClassName.replace("app-shell", "app-portal");
  const lastLogLine = logs[0] || "нет событий";
  const appVersion = "0.1.0";
  const repoUrl = "https://github.com/rub1kub/codex-remote-console";
  const releaseUrl = `${repoUrl}/releases/tag/v${appVersion}`;
  const commandActions = useMemo<CommandAction[]>(
    () => [
      {
        id: "new-thread",
        label: "Новый диалог",
        detail: selectedProfile ? projectTitleOf(selectedProfile) : "сначала подключите проект",
        icon: <MessageSquare size={15} />,
        disabled: connection !== "connected",
        run: newThread
      },
      {
        id: "settings",
        label: "Настройки",
        detail: "Codex, внешний вид, поведение",
        icon: <SlidersHorizontal size={15} />,
        run: openSettings
      },
      {
        id: "project",
        label: "Добавить проект",
        detail: selectedProfile ? `на основе ${serverLabelOf(selectedProfile)}` : "сервер или локальная папка",
        icon: <Folder size={15} />,
        run: () => openProfile(undefined, selectedProfile)
      },
      {
        id: "refresh",
        label: "Обновить чаты",
        detail: selectedProfile?.projectPath || "нет проекта",
        icon: <RefreshCw size={15} />,
        disabled: connection !== "connected",
        run: () => refreshThreads()
      },
      {
        id: "health",
        label: "Проверить проект",
        detail: "git, scripts, проверки, логи",
        icon: <Check size={15} />,
        disabled: !selectedProfileId,
        run: () => void openProjectHealth()
      },
      {
        id: "diff",
        label: "Изменения",
        detail: "открыть встроенный diff",
        icon: <FileText size={15} />,
        disabled: !selectedProfileId,
        run: () => void openProjectDiff()
      },
      {
        id: "project-commands",
        label: "Команды проекта",
        detail: quickCommands.slice(0, 2).join(" · ") || "быстрые команды",
        icon: <Terminal size={15} />,
        disabled: !selectedProfileId,
        run: () => openProjectCommands()
      },
      {
        id: "doctor",
        label: "Диагностика Codex",
        detail: "codex doctor --summary",
        icon: <Check size={15} />,
        disabled: !selectedProfileId,
        run: () => openProjectCommands(`${selectedProfile?.codexBin || "codex"} doctor --summary --ascii`)
      },
      {
        id: "features",
        label: "Флаги Codex",
        detail: "codex features list",
        icon: <SlidersHorizontal size={15} />,
        disabled: !selectedProfileId,
        run: () => openProjectCommands(`${selectedProfile?.codexBin || "codex"} features list`)
      },
      {
        id: "journal",
        label: "Журнал событий",
        detail: logs[0] || "тихая диагностика",
        icon: <History size={15} />,
        run: () => setJournalOpen(true)
      },
      {
        id: "reconnect",
        label: "Переподключиться",
        detail: selectedProfile ? serverLabelOf(selectedProfile) : "нет проекта",
        icon: <RefreshCw size={15} />,
        disabled: !selectedProfileId || connection === "connecting",
        run: () => connectProject()
      },
      {
        id: "check-cli",
        label: "Проверить Codex CLI",
        detail: selectedProfile ? serverLabelOf(selectedProfile) : "нет проекта",
        icon: <Download size={15} />,
        disabled: !selectedProfileId || isCliWorking,
        run: checkCodexCli
      },
      {
        id: "disconnect",
        label: "Отключиться",
        detail: selectedProfile ? projectTitleOf(selectedProfile) : "нет активного подключения",
        icon: <Power size={15} />,
        disabled: connection !== "connected",
        run: disconnect
      }
    ],
    [connection, isCliWorking, logs, quickCommands, selectedProfile, selectedProfileId]
  );
  const filteredCommandActions = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return commandActions;
    return commandActions.filter((action) =>
      `${action.label} ${action.detail}`.toLowerCase().includes(query)
    );
  }, [commandActions, commandQuery]);
  const renderLayer = (content: ReactNode) =>
    typeof document === "undefined"
      ? content
      : createPortal(<div className={portalClassName}>{content}</div>, document.body);

  const renderThreadRow = (thread: CodexThread) => {
    const pinned = Boolean(threadMetadata[thread.id]?.pinned);
    const isThreadLoading = loadingThreadId === thread.id;
    const isDeleting = pendingDeleteThreadId === thread.id;
    const threadTitle = displayTitleOf(thread, threadMetadata[thread.id]);
    return (
      <div
        key={thread.id}
        className={`thread-row ${activeThread?.id === thread.id ? "active" : ""} ${pinned ? "pinned" : ""}`}
        onContextMenu={(event) => openThreadContextMenu(event, thread)}
        title="ПКМ: меню чата"
      >
        <button className="thread-main" onClick={() => selectThread(thread)} disabled={isDeleting}>
          <span>{threadTitle}</span>
          <small>{formatDate(thread.updatedAt)} · {thread.source}</small>
        </button>
        <div className="thread-actions">
          {isThreadLoading && <Loader2 size={14} className="thread-loading spin" aria-hidden="true" />}
          <button
            className="thread-action"
            onClick={() => void togglePin(thread)}
            title={pinned ? "Открепить чат" : "Закрепить чат"}
            aria-label={pinned ? "Открепить чат" : "Закрепить чат"}
            aria-pressed={pinned}
            disabled={isDeleting}
          >
            <Pin size={14} fill={pinned ? "currentColor" : "none"} />
          </button>
        </div>
      </div>
    );
  };

  function runCommandAction(action: CommandAction) {
    if (action.disabled) return;
    setCommandOpen(false);
    setCommandQuery("");
    action.run();
  }

  return (
    <main className={rootClassName}>
      <div className="window-titlebar" aria-hidden="true">
        <span>Codex Remote</span>
      </div>

      <aside className="sidebar">
        <section className="project-panel">
          <div className="section-head">
            <div>
              <Folder size={15} />
              <span>Проекты</span>
            </div>
            <button
              className="small-command"
              onClick={() => openProfile(undefined, selectedProfile)}
              title="Новый проект или папка"
            >
              <Plus size={14} />
              Проект
            </button>
          </div>

          <div className="project-list">
            {projectGroups.map((group) => (
              <section key={group.key} className="project-group">
                <div className="server-row">
                  <Server size={13} />
                  <span>{group.label}</span>
                </div>
                {group.profiles.map((profile) => {
                  const isActiveProject = profile.id === selectedProfileId;
                  const projectConnection = isActiveProject ? connection : "idle";
                  const projectStateLabel =
                    projectConnection === "connected"
                      ? "Подключено"
                      : projectConnection === "connecting"
                        ? "Подключение"
                        : "Не подключено";
                  const projectTitle = projectTitleOf(profile);

                  const canDisconnectProject = isActiveProject && projectConnection === "connected";

                  return (
                    <div
                      key={profile.id}
                      className={`project-row ${isActiveProject ? "active" : ""} ${projectConnection}`}
                      onClick={() => runProject(profile.id)}
                      onKeyDown={(event) => handleProjectKey(event, profile.id)}
                      role="button"
                      tabIndex={connection === "connecting" ? -1 : 0}
                      aria-disabled={connection === "connecting"}
                      title={`${projectTitle} · ${projectStateLabel}`}
                      aria-label={`${projectTitle}. ${projectStateLabel}`}
                    >
                      <Folder className="project-icon" size={15} />
                      <span className="project-copy">
                        <span className="project-name-line">
                          <span className="project-name">{projectTitle}</span>
                        </span>
                        <small className="project-path">{profile.projectPath}</small>
                      </span>
                      {canDisconnectProject && (
                        <button
                          type="button"
                          className="project-disconnect"
                          onClick={(event) => {
                            event.stopPropagation();
                            disconnect();
                          }}
                          title="Отключить проект"
                          aria-label="Отключить проект"
                        >
                          <Power size={14} />
                        </button>
                      )}
                      {projectConnection === "connecting" && (
                        <Loader2 size={13} className="project-activity spin" aria-hidden="true" />
                      )}
                      {projectConnection === "connected" && (
                        <span className="project-activity project-dot" aria-hidden="true" />
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
            {profiles.length === 0 && (
              <div className="empty-note">Проектов пока нет.</div>
            )}
          </div>
        </section>

        <div className="session-head">
          <div>
            <History size={15} />
            <span>Чаты</span>
            <small>{visibleThreads.length}</small>
          </div>
          <button className="new-dialog-button" onClick={newThread} disabled={connection !== "connected"}>
            <Plus size={14} />
            Новый диалог
          </button>
        </div>

        <div className="search-box">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => refreshThreads(event.target.value)}
            placeholder="Поиск чатов"
            autoComplete="off"
          />
        </div>

        <div className="thread-list">
          {pinnedThreads.length > 0 && (
            <div className="thread-group-label">Закрепленные</div>
          )}
          {pinnedThreads.map(renderThreadRow)}
          {pinnedThreads.length > 0 && recentThreads.length > 0 && (
            <div className="thread-group-label">Недавние</div>
          )}
          {recentThreads.map(renderThreadRow)}
          {connection === "connected" && visibleThreads.length === 0 && (
            <div className="empty-note">В этой папке пока нет чатов.</div>
          )}
        </div>
      </aside>

      <section className="chat">
        <header className="chat-header">
          <div className="chat-title">
            <h1>{activeThreadTitle}</h1>
            <p>{selectedProfile?.projectPath || "Выберите сервер и папку проекта"}</p>
          </div>
          <div className="header-actions">
            <button className="header-settings" onClick={() => setCommandOpen(true)} title="Команды" aria-label="Команды">
              <Command size={16} />
            </button>
            <button className="header-settings" onClick={openSettings} title="Настройки" aria-label="Настройки">
              <SlidersHorizontal size={16} />
            </button>
            <div className={`connection-chip ${connection}`} title={statusText[connection]}>
              <Circle size={7} fill="currentColor" />
              {statusText[connection]}
            </div>
          </div>
        </header>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <div className="error-banner-actions">
              {threadNotFoundRecovery && (
                <>
                  <button type="button" onClick={() => refreshThreads()}>
                    Обновить
                  </button>
                  {activeThread && (
                    <button type="button" onClick={() => void hideActiveThreadLocally()}>
                      Скрыть
                    </button>
                  )}
                </>
              )}
              <button type="button" className="icon-only" onClick={() => setError("")} aria-label="Закрыть">
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {connection !== "connected" && reconnectAttempt > 0 && !isReconnectPaused && (
          <div className="reconnect-banner">
            <Loader2 size={15} className="spin" />
            <span>Соединение потеряно · переподключаюсь {reconnectAttempt}/5</span>
            <button type="button" onClick={stopReconnect}>Остановить</button>
          </div>
        )}

        <div className={loadingThreadId || messages.length === 0 ? "messages empty" : "messages"}>
          {loadingThreadId ? (
            <div className="thread-loading-state">
              <Loader2 size={26} className="spin" />
              <h2>Загружаю чат</h2>
              <p>Поднимаю историю с сервера.</p>
            </div>
          ) : showCodexBootstrap ? (
            <div className="bootstrap-card">
              <Terminal size={28} />
              <h2>Codex не установлен</h2>
              <p>{selectedCliStatus?.message || "Установите Codex CLI на выбранном проекте и подключитесь снова."}</p>
              <div className="bootstrap-actions">
                <button type="button" className="primary-button" onClick={updateCodexCli} disabled={isCliWorking}>
                  {cliPhase === "updating" ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                  Установить Codex
                </button>
                <button type="button" className="secondary-button" onClick={checkCodexCli} disabled={isCliWorking}>
                  {cliPhase === "checking" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                  Проверить
                </button>
                <button type="button" className="secondary-button" onClick={openSettings}>
                  <SlidersHorizontal size={15} />
                  Настройки
                </button>
              </div>
            </div>
          ) : recoveryTask && connection !== "connected" && recoveryTask.profileId === selectedProfileId ? (
            <div className="bootstrap-card recovery-card">
              <History size={28} />
              <h2>Есть незавершенная задача</h2>
              <p>{recoveryTask.title}</p>
              <div className="bootstrap-actions">
                <button type="button" className="primary-button" onClick={() => connectProject(recoveryTask.profileId)}>
                  <RefreshCw size={15} />
                  Переподключиться
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    writeStoredActiveTask(null);
                    setRecoveryTask(null);
                  }}
                >
                  <X size={15} />
                  Скрыть
                </button>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className="welcome">
              <MessageSquare size={28} />
              <h2>Откройте чат или напишите Codex</h2>
              <p>История появится после подключения.</p>
            </div>
          ) : (
            <>
              {turnDisplay.map((turn) => (
                <section key={turn.id} className="turn-group">
                  {turn.user && (
                    <article className="message user">
                      <div className="message-avatar">{messageAvatarLabel.user}</div>
                      <div className="message-body">
                        <div className="message-head">
                          <span className="message-author">{messageRoleLabel.user}</span>
                        </div>
                        <div className="message-content">{renderTextBlocks(turn.user)}</div>
                      </div>
                    </article>
                  )}

                  {turn.items.map((item) => {
                    if (item.type === "steps") {
                      const isOpen = Boolean(openStepGroups[item.id]);
                      return (
                        <article key={item.id} className={`message assistant steps-message ${isOpen ? "open" : ""}`}>
                          <div className="message-avatar">C</div>
                          <section className={`steps-summary ${isOpen ? "open" : ""}`}>
                            <button
                              type="button"
                              className="steps-toggle"
                              onClick={() =>
                                setOpenStepGroups((current) => ({
                                  ...current,
                                  [item.id]: !current[item.id]
                                }))
                              }
                            >
                              {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                              <span>Ход работы</span>
                              <small>{item.messages.length}</small>
                            </button>
                            {isOpen && (
                              <div className="steps-list">
                                {item.messages.map((message) => (
                                  <article key={message.id} className={`step-item ${message.role}`}>
                                    <span>{stepLabelOf(message)}</span>
                                    <p>{stepPreviewOf(message)}</p>
                                  </article>
                                ))}
                              </div>
                            )}
                          </section>
                        </article>
                      );
                    }

                    const { message } = item;
                    return (
                      <article key={message.id} className={`message ${message.role}`}>
                        <div className="message-avatar">
                          {message.role === "tool" ? <Terminal size={15} /> : messageAvatarLabel[message.role]}
                        </div>
                        <div className="message-body">
                          <div className="message-head">
                            <span className="message-author">{messageRoleLabel[message.role]}</span>
                            {message.title && <span className="message-title">{message.title}</span>}
                          </div>
                          <div className="message-content">{renderTextBlocks(message)}</div>
                        </div>
                      </article>
                    );
                  })}

                  {turn.files.length > 0 && (
                    <article className="message assistant files-message">
                      <div className="message-avatar">
                        <FileText size={15} />
                      </div>
                      <div className="message-body files-body">
                        <div className="message-head">
                          <span className="message-author">Файлы</span>
                          <span className="message-title">{turn.files.length}</span>
                        </div>
                        <div className="file-summary-list">
                          {turn.files.map((file) => (
                            <button
                              key={file.key}
                              type="button"
                              className="file-summary-chip"
                              title={file.path}
                              onClick={() => void openProjectDiff(turn.files)}
                            >
                              {file.operation && <small>{file.operation}</small>}
                              {file.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </article>
                  )}
                </section>
              ))}
            </>
          )}
          {!loadingThreadId && messages.length > 0 && <div ref={endRef} />}
        </div>

        {lastTaskSummary && (
          <section className="task-summary-card">
            <div className="task-summary-head">
              <div>
                <Check size={15} />
                <strong>Итог задачи</strong>
              </div>
              <small>{formatDate(Math.floor(lastTaskSummary.completedAt / 1000))}</small>
            </div>
            <div className="task-summary-grid">
              <span>время <strong>{formatDuration(lastTaskSummary.elapsedMs)}</strong></span>
              <span>{formatTokens(lastTaskSummary.tokens)}</span>
              <span>команды <strong>{lastTaskSummary.commands.length}</strong></span>
              <span>проверки <strong>{lastTaskSummary.tests.length || "--"}</strong></span>
            </div>
            {lastTaskSummary.files.length > 0 && (
              <div className="task-summary-files">
                <button type="button" onClick={() => void openProjectDiff(lastTaskSummary.files)}>
                  <FileText size={14} />
                  Файлы {lastTaskSummary.files.length}
                </button>
                {lastTaskSummary.files.slice(0, 5).map((file) => (
                  <button key={file.key} type="button" onClick={() => void openProjectDiff([file])}>
                    {file.label}
                  </button>
                ))}
              </div>
            )}
            {lastTaskSummary.commands.length > 0 && (
              <details className="task-summary-details">
                <summary>Команды</summary>
                {lastTaskSummary.commands.map((command, index) => (
                  <code key={`${command.command}-${index}`}>
                    {command.command}
                    {command.exitCode !== undefined && command.exitCode !== null ? ` · ${command.exitCode}` : ""}
                  </code>
                ))}
              </details>
            )}
          </section>
        )}

        {showTaskStatus && (
          <div className={`task-status ${isBusy ? "working" : "done"}`}>
            <div className="task-status-main">
              {isBusy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              <span>{isBusy ? "Codex работает" : "Codex закончил"}</span>
              <small>{taskStatusLabel}</small>
            </div>
            <div className="task-status-metrics">
              {preferences.showTaskTimer && (
                <span>{formatDuration(taskElapsedMs)}</span>
              )}
              {preferences.showTokenUsage && (
                <span>{taskTokenLabel}</span>
              )}
            </div>
          </div>
        )}

        {taskQueue.length > 0 && (
          <div className="queue-status">
            <History size={15} />
            <span>В очереди {taskQueue.length}</span>
            <button type="button" onClick={() => setTaskQueue([])}>Очистить</button>
          </div>
        )}

        <form className="composer" onSubmit={submit}>
          <div className="composer-box">
            {visibleSlashCommands.length > 0 && (
              <div className="composer-suggest slash-suggest">
                {visibleSlashCommands.map((item) => (
                  <button
                    key={item.command}
                    type="button"
                    onClick={() => {
                      if (item.command !== "/mention") {
                        handleSlashInput(item.command);
                        setInput("");
                      } else {
                        setInput("@");
                      }
                    }}
                  >
                    <code>{item.command}</code>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}

            {(fileMentionResults.length > 0 || isFileMentionLoading) && fileMentionQuery && (
              <div className="composer-suggest mention-suggest">
                {isFileMentionLoading ? (
                  <span className="suggest-loading"><Loader2 size={14} className="spin" /> Ищу файлы</span>
                ) : (
                  fileMentionResults.map((file) => (
                    <button key={file.path} type="button" onClick={() => applyFileMention(file)}>
                      <FileText size={14} />
                      <span>{file.path}</span>
                    </button>
                  ))
                )}
              </div>
            )}

            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={connection === "connected" ? "Напишите задачу Codex..." : "Сначала подключитесь к проекту"}
              disabled={connection !== "connected"}
              rows={1}
              onKeyDown={(event) => {
                if (preferences.enterToSend && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(event);
                }
              }}
            />

            <div className="composer-controls" onClick={(event) => event.stopPropagation()}>
              <div className="composer-toggles">
                <div className="composer-menu-anchor">
                  <button
                    type="button"
                    className={`composer-control composer-settings-control ${isComposerMenuOpen ? "active" : ""}`}
                    onClick={toggleComposerMenu}
                    title="Модель и режим ответа"
                  >
                    <Gauge size={14} />
                    {selectedModelLabel && <span>{selectedModelLabel}</span>}
                    <span>{selectedReasoningLabel}</span>
                    <ChevronDown size={13} />
                  </button>
                  {isComposerMenuOpen && (
                    <div className="composer-popover settings-popover">
                      <section className="popover-section">
                        <div className="popover-section-head">
                          <Brain size={14} />
                          <span>Рассуждение</span>
                        </div>
                        {reasoningOptions.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className="popover-option"
                            onClick={() => {
                              setComposerMenuOpen(false);
                              void updatePreferences({ reasoningLevel: option.value });
                            }}
                          >
                            <span>{option.label}</span>
                            {preferences.reasoningLevel === option.value && <Check size={15} />}
                          </button>
                        ))}
                      </section>

                      <section className="popover-section">
                        <button
                          type="button"
                          className={`popover-disclosure ${openComposerSubmenu === "model" ? "open" : ""}`}
                          onClick={() =>
                            setOpenComposerSubmenu((current) =>
                              current === "model" ? null : "model"
                            )
                          }
                        >
                          <span className="popover-disclosure-title">
                            <Gauge size={14} />
                            <span>Модель</span>
                          </span>
                          <span className="popover-current">
                            {selectedModelOption?.label || selectedModelValue.replace(/^gpt-/, "") || "по умолчанию"}
                          </span>
                          {openComposerSubmenu === "model" ? (
                            <ChevronDown size={15} />
                          ) : (
                            <ChevronRight size={15} />
                          )}
                        </button>
                        {openComposerSubmenu === "model" && (
                          <div className="popover-nested">
                            {modelOptions.map((option) => (
                              <button
                                key={option.value || "default"}
                                type="button"
                                className="popover-option"
                                onClick={() => void updateSelectedModel(option.value)}
                              >
                                <span>{option.label}</span>
                                {selectedModelValue === option.value && <Check size={15} />}
                              </button>
                            ))}
                          </div>
                        )}
                      </section>

                      <section className="popover-section">
                        <button
                          type="button"
                          className={`popover-disclosure ${openComposerSubmenu === "speed" ? "open" : ""}`}
                          onClick={() =>
                            setOpenComposerSubmenu((current) =>
                              current === "speed" ? null : "speed"
                            )
                          }
                        >
                          <span className="popover-disclosure-title">
                            <Zap size={14} />
                            <span>Скорость</span>
                          </span>
                          <span className="popover-current">{selectedSpeedLabel}</span>
                          {openComposerSubmenu === "speed" ? (
                            <ChevronDown size={15} />
                          ) : (
                            <ChevronRight size={15} />
                          )}
                        </button>
                        {openComposerSubmenu === "speed" && (
                          <div className="popover-nested">
                            {speedOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className="popover-option stacked"
                                onClick={() => {
                                  setComposerMenuOpen(false);
                                  setOpenComposerSubmenu(null);
                                  void updatePreferences({ responseSpeed: option.value });
                                }}
                              >
                                <span>{option.label}</span>
                                <small>{option.description}</small>
                                {preferences.responseSpeed === option.value && <Check size={15} />}
                              </button>
                            ))}
                          </div>
                        )}
                      </section>
                    </div>
                  )}
                </div>
              </div>

              {isBusy ? (
                <>
                  <button className="send-button queue" disabled={!canSend} title={sendButtonLabel}>
                    <ArrowUp size={15} />
                  </button>
                  <button type="button" className="send-button stop" onClick={() => send({ type: "interrupt" })} title="Остановить">
                    <Square size={15} />
                  </button>
                </>
              ) : (
                <button className="send-button" disabled={!canSend} title={sendButtonLabel}>
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
        </form>

        {preferences.showDiagnostics && logs.length > 0 && (
          <details className="diagnostics">
            <summary>Журнал</summary>
            {logs.map((line, index) => (
              <code key={`${line}-${index}`}>{line}</code>
            ))}
          </details>
        )}
      </section>

      {isProfileOpen && renderLayer(
        <div className="modal-backdrop" role="presentation">
          <form className="profile-modal" onSubmit={saveDraft}>
            <div className="modal-head">
              <h2>{editingProfile ? "Проект" : "Новый проект"}</h2>
              <button type="button" className="icon-button" onClick={() => setProfileOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <label>
              Название проекта
              <input
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder="zavozik.xyz"
                autoComplete="organization"
              />
              <small>Если оставить пустым, имя возьмется из выбранной папки.</small>
            </label>

            <label>
              Где работать
              <select
                value={draft.mode}
                onChange={(event) => updateDraft(
                  { mode: event.target.value as ProfileDraft["mode"] },
                  true
                )}
              >
                <option value="ssh">На сервере</option>
                <option value="local">На этом компьютере</option>
              </select>
            </label>

            {draft.mode === "ssh" && (
              <>
                <label>
                  Сервер
                  <input
                    value={draft.sshTarget}
                    onChange={(event) => updateDraft({ sshTarget: event.target.value }, true)}
                    placeholder="root@94.156.112.224"
                    autoComplete="username"
                  />
                </label>
                <label>
                  Пароль
                  <div className="password-field">
                    <KeyRound size={15} />
                    <input
                      type="password"
                      value={draft.password ?? ""}
                      onChange={(event) => updateDraft({ password: event.target.value }, true)}
                      placeholder="не сохраняется"
                      autoComplete="current-password"
                    />
                  </div>
                  <small>Используется только для текущего подключения.</small>
                </label>
                <details className="advanced-details">
                  <summary>Параметры SSH</summary>
                  <div className="two-fields">
                    <label>
                      Порт
                      <input
                        value={draft.port ?? ""}
                        onChange={(event) => updateDraft(
                          { port: event.target.value ? Number(event.target.value) : undefined },
                          true
                        )}
                        placeholder="22"
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Ключ SSH
                      <input
                        value={draft.identityFile ?? ""}
                        onChange={(event) => updateDraft({ identityFile: event.target.value }, true)}
                        placeholder="~/.ssh/id_ed25519"
                        autoComplete="off"
                      />
                    </label>
                  </div>
                </details>
              </>
            )}

            <label>
              Папка проекта
              <div className="folder-picker">
                <div className="folder-path-row">
                  <input
                    value={draft.projectPath}
                    onChange={(event) => updateDraft({ projectPath: event.target.value })}
                    placeholder="/var/www/zavozik.xyz"
                    autoComplete="off"
                    required
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void loadDirectories()}
                    disabled={isDirectoryLoading}
                  >
                    {isDirectoryLoading ? <Loader2 size={15} className="spin" /> : <FolderOpen size={15} />}
                    Выбрать папку
                  </button>
                </div>

                <div className="quick-paths">
                  <button type="button" onClick={() => void loadDirectories("~")}>~</button>
                  <button type="button" onClick={() => void loadDirectories("/var/www")}>/var/www</button>
                  <button type="button" onClick={() => void loadDirectories("/home")}>/home</button>
                  {recentProjectPaths.slice(0, 4).map((recentPath) => (
                    <button key={recentPath} type="button" onClick={() => void loadDirectories(recentPath)}>
                      {recentPath}
                    </button>
                  ))}
                </div>

                {directoryError && <div className="folder-error">{directoryError}</div>}

                <div className="folder-browser">
                  <div className="folder-browser-head">
                    <button
                      type="button"
                      onClick={() => directoryListing?.parentPath && void loadDirectories(directoryListing.parentPath)}
                      disabled={!directoryListing?.parentPath || isDirectoryLoading}
                      title="На уровень выше"
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <span>{directoryListing?.currentPath || "Выберите папку"}</span>
                    <button
                      type="button"
                      onClick={() => void loadDirectories(directoryListing?.currentPath)}
                      disabled={!directoryListing || isDirectoryLoading}
                      title="Обновить"
                    >
                      <RefreshCw size={14} className={isDirectoryLoading ? "spin" : ""} />
                    </button>
                  </div>

                  {directoryListing && (
                    <div className="folder-current">
                      <FolderOpen size={15} />
                      <span>{directoryListing.currentPath}</span>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => updateDraft({
                          name: draft.name.trim() ? draft.name : basenameOf(directoryListing.currentPath),
                          projectPath: directoryListing.currentPath
                        })}
                      >
                        <Check size={14} />
                        Выбрать
                      </button>
                    </div>
                  )}

                  <div className="folder-list">
                    {directoryListing ? (
                      directoryListing.entries.length > 0 ? (
                        directoryListing.entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            className="folder-row"
                            onClick={() => void loadDirectories(entry.path)}
                          >
                            <Folder size={15} />
                            <span>{entry.name}</span>
                            <small className={entry.isGit || entry.hasPackageJson ? "folder-badges" : "folder-badges empty"}>
                              {entry.isGit && "git"}
                              {entry.isGit && entry.hasPackageJson && " · "}
                              {entry.hasPackageJson && "app"}
                            </small>
                          </button>
                        ))
                      ) : (
                        <div className="folder-empty">Подпапок нет. Можно сохранить эту папку.</div>
                      )
                    ) : (
                      <div className="folder-empty folder-empty-action">
                        <span>Папки появятся здесь.</span>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void loadDirectories()}
                          disabled={isDirectoryLoading}
                        >
                          {isDirectoryLoading ? <Loader2 size={15} className="spin" /> : <FolderOpen size={15} />}
                          Открыть список
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </label>

            <details className="advanced-details">
              <summary>Параметры Codex</summary>
              <div className="two-fields">
                <label>
                  Команда Codex
                  <input
                    value={draft.codexBin}
                    onChange={(event) => updateDraft({ codexBin: event.target.value })}
                    placeholder="codex"
                    autoComplete="off"
                  />
                </label>
                <label>
                  Модель
                  <select
                    value={draft.model ?? ""}
                    onChange={(event) => updateDraft({ model: event.target.value || undefined })}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.value || "default"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                    {draft.model && !modelOptions.some((option) => option.value === draft.model) && (
                      <option value={draft.model}>{draft.model}</option>
                    )}
                  </select>
                </label>
              </div>

              <label>
                Команда установки/обновления Codex
                <input
                  value={draft.updateCommand ?? ""}
                  onChange={(event) => updateDraft({ updateCommand: event.target.value })}
                  placeholder={preferences.defaultUpdateCommand}
                  autoComplete="off"
                />
              </label>

              <label>
                Быстрые команды проекта
                <textarea
                  value={(draft.quickCommands ?? []).join("\n")}
                  onChange={(event) => updateDraft({
                    quickCommands: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
                  })}
                  placeholder={"git status --short\nnpm test\nnpm run build"}
                  rows={3}
                />
                <small>По одной команде на строку. Запускаются из меню проекта.</small>
              </label>

              <div className="two-fields">
                <label>
                  Подтверждения
                  <select
                    value={draft.approvalPolicy}
                    onChange={(event) => updateDraft({ approvalPolicy: event.target.value as ProfileDraft["approvalPolicy"] })}
                  >
                    <option value="never">не спрашивать</option>
                    <option value="on-request">спрашивать при необходимости</option>
                    <option value="on-failure">спрашивать после ошибки</option>
                    <option value="untrusted">строгий режим</option>
                  </select>
                </label>
                <label>
                  Доступ к файлам
                  <select
                    value={draft.sandboxMode}
                    onChange={(event) => updateDraft({ sandboxMode: event.target.value as ProfileDraft["sandboxMode"] })}
                  >
                    <option value="danger-full-access">полный доступ</option>
                    <option value="workspace-write">запись в проекте</option>
                    <option value="read-only">только чтение</option>
                  </select>
                </label>
              </div>
            </details>

            <div className="modal-actions">
              {editingProfile && (
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    void removeProfile(editingProfile);
                    setProfileOpen(false);
                  }}
                >
                  <Trash2 size={15} />
                  Удалить
                </button>
              )}
              <button type="submit" className="primary-button">Сохранить</button>
            </div>
          </form>
        </div>
      )}

      {renamingThread && renderLayer(
        <div className="modal-backdrop" role="presentation">
          <form className="profile-modal chat-modal" onSubmit={saveThreadTitle}>
            <div className="modal-head">
              <div>
                <h2>Переименовать чат</h2>
                <p>{renamingThread.cwd || selectedProfile?.projectPath}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setRenamingThread(null)}>
                <X size={16} />
              </button>
            </div>
            <label>
              Название
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                autoFocus
                autoComplete="off"
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setRenamingThread(null)}>
                Отмена
              </button>
              <button type="submit" className="primary-button">
                Сохранить
              </button>
            </div>
          </form>
        </div>
      )}

      {deletingThread && renderLayer(
        <div className="modal-backdrop" role="presentation">
          <div className="profile-modal chat-modal confirm-modal">
            <div className="modal-head">
              <div>
                <h2>Удалить чат?</h2>
                <p>{displayTitleOf(deletingThread, threadMetadata[deletingThread.id])}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setDeletingThread(null)}>
                <X size={16} />
              </button>
            </div>
            <p className="confirm-copy">
              Чат будет удален из локального списка и Codex-хранилища на сервере.
              Действие нельзя отменить.
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setDeletingThread(null)}>
                Отмена
              </button>
              <button type="button" className="danger-button strong" onClick={() => void confirmDeleteThread()}>
                <Trash2 size={15} />
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}

      {diffPanel.open && renderLayer(
        <div className="modal-backdrop panel-backdrop" role="presentation">
          <section className="profile-modal wide-panel">
            <div className="modal-head">
              <div>
                <h2>Изменения</h2>
                <p>{diffPanel.files.length ? `${diffPanel.files.length} файлов` : selectedProfile?.projectPath}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setDiffPanel({ open: false, loading: false, files: [] })}>
                <X size={16} />
              </button>
            </div>
            {diffPanel.loading ? (
              <div className="panel-loading">
                <Loader2 size={18} className="spin" />
                Читаю diff
              </div>
            ) : diffPanel.error ? (
              <div className="folder-error">{diffPanel.error}</div>
            ) : (
              <div className="diff-viewer">
                <section>
                  <h3>Статус</h3>
                  <pre>{diffPanel.result?.status || "Изменений нет."}</pre>
                </section>
                <section>
                  <h3>Diff</h3>
                  <pre>{diffPanel.result?.diff || "Diff пустой."}</pre>
                </section>
              </div>
            )}
          </section>
        </div>
      )}

      {healthPanel.open && renderLayer(
        <div className="modal-backdrop panel-backdrop" role="presentation">
          <section className="profile-modal wide-panel">
            <div className="modal-head">
              <div>
                <h2>Проверка проекта</h2>
                <p>{selectedProfile?.projectPath || "Проект не выбран"}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setHealthPanel({ open: false, loading: false })}>
                <X size={16} />
              </button>
            </div>
            {healthPanel.loading ? (
              <div className="panel-loading">
                <Loader2 size={18} className="spin" />
                Проверяю проект
              </div>
            ) : healthPanel.error ? (
              <div className="folder-error">{healthPanel.error}</div>
            ) : healthPanel.result && (
              <>
                <div className="health-grid">
                  <div><span>Git</span><strong>{healthPanel.result.isGit ? "есть" : "нет"}</strong></div>
                  <div><span>Изменения</span><strong>{healthPanel.result.dirtyFiles || "--"}</strong></div>
                  <div><span>package.json</span><strong>{healthPanel.result.packageJson ? "есть" : "нет"}</strong></div>
                  <div><span>Пакетный менеджер</span><strong>{healthPanel.result.packageManager}</strong></div>
                  <div><span>Проверки</span><strong>{healthPanel.result.availableChecks.length || "--"}</strong></div>
                  <div><span>Скрипты</span><strong>{healthPanel.result.scripts.length || "--"}</strong></div>
                </div>
                <div className="health-actions">
                  <button type="button" className="secondary-button" onClick={() => void openProjectDiff()}>
                    <FileText size={15} />
                    Diff
                  </button>
                  {healthPanel.result.availableChecks.slice(0, 4).map((script) => (
                    <button key={script} type="button" className="secondary-button" onClick={() => openProjectCommands(packageScriptCommand(healthPanel.result?.packageManager || "npm", script))}>
                      <Terminal size={15} />
                      {script}
                    </button>
                  ))}
                </div>
                <div className="health-sections">
                  {healthPanel.result.sections.map((section) => (
                    <details key={section.title} open={["git", "checks"].includes(section.title)}>
                      <summary>{section.title}</summary>
                      <pre>{section.body || "пусто"}</pre>
                    </details>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {commandRunner.open && renderLayer(
        <div className="modal-backdrop panel-backdrop" role="presentation">
          <section className="profile-modal command-runner-panel">
            <div className="modal-head">
              <div>
                <h2>Команды проекта</h2>
                <p>{selectedProfile?.projectPath || "Проект не выбран"}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setCommandRunner({ open: false, running: false, command: "" })}>
                <X size={16} />
              </button>
            </div>
            <div className="quick-command-list">
              {quickCommands.map((command) => (
                <button key={command} type="button" onClick={() => void runProjectCommand(command)}>
                  <Terminal size={14} />
                  {command}
                </button>
              ))}
            </div>
            <label>
              Команда
              <input
                value={commandRunner.command}
                onChange={(event) => setCommandRunner((current) => ({ ...current, command: event.target.value }))}
                placeholder="git status --short"
                autoComplete="off"
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="primary-button" onClick={() => void runProjectCommand()} disabled={commandRunner.running}>
                {commandRunner.running ? <Loader2 size={15} className="spin" /> : <Terminal size={15} />}
                Запустить
              </button>
            </div>
            {commandRunner.error && <div className="folder-error">{commandRunner.error}</div>}
            {commandRunner.result && (
              <div className="command-result">
                <div>
                  <span>exit code</span>
                  <strong>{commandRunner.result.exitCode ?? "--"}</strong>
                </div>
                <pre>{[commandRunner.result.stdout, commandRunner.result.stderr].filter(Boolean).join("\n") || "Команда завершилась без вывода."}</pre>
              </div>
            )}
          </section>
        </div>
      )}

      {isJournalOpen && renderLayer(
        <div className="modal-backdrop panel-backdrop" role="presentation">
          <section className="profile-modal journal-panel">
            <div className="modal-head">
              <div>
                <h2>Журнал событий</h2>
                <p>Тихая диагностика приложения</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setJournalOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="journal-list">
              {logs.length > 0 ? logs.map((line, index) => (
                <code key={`${line}-${index}`}>{line}</code>
              )) : (
                <span>Событий пока нет.</span>
              )}
            </div>
          </section>
        </div>
      )}

      {isCommandOpen && renderLayer(
        <div className="modal-backdrop command-backdrop" role="presentation">
          <div className="command-modal" role="dialog" aria-label="Команды">
            <div className="command-search">
              <Command size={16} />
              <input
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const action = filteredCommandActions.find((item) => !item.disabled);
                    if (action) runCommandAction(action);
                  }
                }}
                placeholder="Что сделать?"
                autoFocus
              />
              <button type="button" onClick={() => setCommandOpen(false)} aria-label="Закрыть">
                <X size={15} />
              </button>
            </div>
            <div className="command-list">
              {filteredCommandActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="command-item"
                  onClick={() => runCommandAction(action)}
                  disabled={action.disabled}
                >
                  <span className="command-icon">{action.icon}</span>
                  <span>
                    <strong>{action.label}</strong>
                    <small>{action.detail}</small>
                  </span>
                </button>
              ))}
              {filteredCommandActions.length === 0 && (
                <div className="command-empty">Нет действий</div>
              )}
            </div>
          </div>
        </div>
      )}

      {threadMenu && renderLayer(
        <div
          className="thread-context-menu"
          style={{ left: threadMenu.x, top: threadMenu.y }}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const targetThread = threadMenu.thread;
              setThreadMenu(null);
              void togglePin(targetThread);
            }}
          >
            <Pin size={15} fill={threadMetadata[threadMenu.thread.id]?.pinned ? "currentColor" : "none"} />
            {threadMetadata[threadMenu.thread.id]?.pinned ? "Открепить" : "Закрепить"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const targetThread = threadMenu.thread;
              setThreadMenu(null);
              send({ type: "forkThread", threadId: targetThread.id });
            }}
          >
            <MessageSquare size={15} />
            Копия чата
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const targetThread = threadMenu.thread;
              setThreadMenu(null);
              send({ type: "compactThread", threadId: targetThread.id });
            }}
          >
            <History size={15} />
            Сжать
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openRenameThread(threadMenu.thread);
              setThreadMenu(null);
            }}
          >
            <Pencil size={15} />
            Переименовать
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const targetThread = threadMenu.thread;
              setThreadMenu(null);
              send({ type: "archiveThread", threadId: targetThread.id });
              setThreads((current) => current.filter((thread) => thread.id !== targetThread.id));
            }}
          >
            <Folder size={15} />
            Архивировать
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setDeletingThread(threadMenu.thread);
              setThreadMenu(null);
            }}
          >
            <Trash2 size={15} />
            Удалить
          </button>
        </div>
      )}

      {(isSettingsOpen || isSettingsClosing) && renderLayer(
        <div className={`settings-backdrop ${isSettingsClosing ? "closing" : ""}`} role="presentation">
          <aside className="settings-drawer" aria-label="Настройки">
            <div className="modal-head">
              <div>
                <h2>Настройки</h2>
                <p>Поведение приложения и Codex</p>
              </div>
              <button type="button" className="icon-button" onClick={closeSettings}>
                <X size={16} />
              </button>
            </div>

            <section className="settings-section">
              <h3>Codex</h3>
              <div className="cli-status-card">
                <div>
                  <span>Версия</span>
                  <strong>{cliVersionLabel}</strong>
                </div>
                <div>
                  <span>Новая версия</span>
                  <strong>{selectedCliStatus?.latest || "неизвестно"}</strong>
                </div>
                <button className="secondary-button" onClick={checkCodexCli} disabled={!selectedProfileId || isCliWorking}>
                  {cliPhase === "checking" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                  Проверить
                </button>
                <button
                  className="primary-button"
                  onClick={updateCodexCli}
                  disabled={!canInstallOrUpdateCodex}
                >
                  {cliPhase === "updating" ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                  {codexActionLabel}
                </button>
              </div>
              {selectedCliStatus?.message && (
                <div className="cli-install-note">
                  <Terminal size={14} />
                  <span>{selectedCliStatus.message}</span>
                </div>
              )}
              <label>
                Команда установки/обновления по умолчанию
                <input
                  value={preferences.defaultUpdateCommand}
                  onChange={(event) => void updatePreferences({ defaultUpdateCommand: event.target.value })}
                  autoComplete="off"
                />
              </label>
              <label className="toggle-row">
                <span>Проверять обновления при подключении</span>
                <input
                  type="checkbox"
                  checked={preferences.autoCheckUpdates}
                  onChange={(event) => void updatePreferences({ autoCheckUpdates: event.target.checked })}
                />
              </label>
            </section>

            <section className="settings-section">
              <h3>Сервер</h3>
              <div className="monitor-grid">
                <div>
                  <span>Проект</span>
                  <strong>{selectedProfile ? projectTitleOf(selectedProfile) : "не выбран"}</strong>
                </div>
                <div>
                  <span>Подключение</span>
                  <strong>{statusText[connection]}</strong>
                </div>
                <div>
                  <span>App server</span>
                  <strong>{codexStatus || "нет статуса"}</strong>
                </div>
                <div>
                  <span>Чаты</span>
                  <strong>{visibleThreads.length}</strong>
                </div>
                <div>
                  <span>Codex CLI</span>
                  <strong>{cliVersionLabel}</strong>
                </div>
                <div>
                  <span>Приложение</span>
                  <strong>{appVersion}</strong>
                </div>
              </div>
              <div className="monitor-log">
                <Terminal size={14} />
                <span>{lastLogLine}</span>
              </div>
            </section>

            <section className="settings-section about-section">
              <div className="about-title">
                <FileText size={16} />
                <h3>О приложении</h3>
              </div>
              <p>
                Codex Remote — настольное приложение для работы с Codex CLI на удаленных серверах без ручного
                входа по SSH, перехода в папку проекта и запуска терминального `codex --yolo`.
              </p>
              <div className="about-grid">
                <div>
                  <span>Версия</span>
                  <strong>{appVersion}</strong>
                </div>
                <div>
                  <span>Платформы</span>
                  <strong>macOS, Windows, Linux</strong>
                </div>
                <div>
                  <span>Формат</span>
                  <strong>Electron + app-server</strong>
                </div>
                <div>
                  <span>Автор</span>
                  <strong>rub1kub</strong>
                </div>
              </div>
              <div className="about-links">
                <a href={releaseUrl} target="_blank" rel="noreferrer">Релиз {appVersion}</a>
                <a href={repoUrl} target="_blank" rel="noreferrer">GitHub</a>
              </div>
            </section>

            <section className="settings-section">
              <h3>Внешний вид</h3>
              <div className="segmented-control">
                <button className={preferences.theme === "light" ? "selected" : ""} onClick={() => void updatePreferences({ theme: "light" })}>
                  <Sun size={15} />
                  Светлая
                </button>
                <button className={preferences.theme === "dark" ? "selected" : ""} onClick={() => void updatePreferences({ theme: "dark" })}>
                  <Moon size={15} />
                  Темная
                </button>
                <button className={preferences.theme === "system" ? "selected" : ""} onClick={() => void updatePreferences({ theme: "system" })}>
                  <Monitor size={15} />
                  Система
                </button>
              </div>
              <div className="segmented-control concept-control">
                <button
                  className={preferences.interfaceStyle === "native" ? "selected" : ""}
                  onClick={() => void updatePreferences({ interfaceStyle: "native" })}
                >
                  <Monitor size={15} />
                  Обычный
                </button>
                <button
                  className={preferences.interfaceStyle === "session-first" ? "selected" : ""}
                  onClick={() => void updatePreferences({ interfaceStyle: "session-first" })}
                >
                  <History size={15} />
                  Чаты
                </button>
                <button
                  className={preferences.interfaceStyle === "calm-terminal" ? "selected" : ""}
                  onClick={() => void updatePreferences({ interfaceStyle: "calm-terminal" })}
                >
                  <Terminal size={15} />
                  Терминал
                </button>
              </div>
              <label className="toggle-row">
                <span>Анимации и живые индикаторы</span>
                <input
                  type="checkbox"
                  checked={preferences.animations}
                  onChange={(event) => void updatePreferences({ animations: event.target.checked })}
                />
              </label>
              <label className="toggle-row">
                <span>Компактный режим</span>
                <input
                  type="checkbox"
                  checked={preferences.compactMode}
                  onChange={(event) => void updatePreferences({ compactMode: event.target.checked })}
                />
              </label>
            </section>

            <section className="settings-section">
              <h3>Поведение</h3>
              <label className="toggle-row">
                <span>Enter отправляет сообщение</span>
                <input
                  type="checkbox"
                  checked={preferences.enterToSend}
                  onChange={(event) => void updatePreferences({ enterToSend: event.target.checked })}
                />
              </label>
              <label className="toggle-row">
                <span>Обновлять историю после ответа</span>
                <input
                  type="checkbox"
                  checked={preferences.autoRefreshHistory}
                  onChange={(event) => void updatePreferences({ autoRefreshHistory: event.target.checked })}
                />
              </label>
              <label className="toggle-row">
                <span>Уведомлять о завершении</span>
                <input
                  type="checkbox"
                  checked={preferences.notifyOnCompletion}
                  onChange={(event) => void updatePreferences({ notifyOnCompletion: event.target.checked })}
                />
              </label>
              <label className="toggle-row">
                <span>Показывать время задачи</span>
                <input
                  type="checkbox"
                  checked={preferences.showTaskTimer}
                  onChange={(event) => void updatePreferences({ showTaskTimer: event.target.checked })}
                />
              </label>
              <label className="toggle-row">
                <span>Показывать токены задачи</span>
                <input
                  type="checkbox"
                  checked={preferences.showTokenUsage}
                  onChange={(event) => void updatePreferences({ showTokenUsage: event.target.checked })}
                />
              </label>
              <label className="toggle-row">
                <span>Показывать журнал</span>
                <input
                  type="checkbox"
                  checked={preferences.showDiagnostics}
                  onChange={(event) => void updatePreferences({ showDiagnostics: event.target.checked })}
                />
              </label>
              <label>
                Лимит истории
                <input
                  type="number"
                  min={10}
                  max={300}
                  value={preferences.historyLimit}
                  onChange={(event) => void updatePreferences({ historyLimit: Number(event.target.value) })}
                  autoComplete="off"
                />
              </label>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
