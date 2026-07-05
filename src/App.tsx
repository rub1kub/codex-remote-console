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

const uiStateStorageKey = "codex-remote-ui-state";

const defaultUpdateCommand =
  "CODEX_NON_INTERACTIVE=1 codex update || npm install -g @openai/codex@latest";

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

const formatDate = (seconds: number) =>
  new Intl.DateTimeFormat("ru", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(seconds * 1000));

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
  if (index === -1) return [...messages, next];
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
    return segment.map((message): MessageDisplayItem => ({ type: "message", message }));
  }

  let finalAssistantIndex = -1;
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    if (segment[index].role === "assistant" && segment[index].text.trim()) {
      finalAssistantIndex = index;
      break;
    }
  }

  if (finalAssistantIndex <= 0) {
    return segment.map((message): MessageDisplayItem => ({ type: "message", message }));
  }

  const collapsed = segment.slice(0, finalAssistantIndex);
  if (collapsed.length === 0) {
    return segment.map((message): MessageDisplayItem => ({ type: "message", message }));
  }

  return [
    { type: "steps", id: buildStepGroupId(collapsed), messages: collapsed },
    ...segment.slice(finalAssistantIndex).map((message): MessageDisplayItem => ({ type: "message", message }))
  ];
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
  const [cliPhase, setCliPhase] = useState<"idle" | "checking" | "checked" | "updating" | "updated">("idle");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [isBusy, setBusy] = useState(false);
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

  const wsRef = useRef<WebSocket | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const preferencesRef = useRef(preferences);
  const sessionPasswordsRef = useRef(sessionPasswords);
  const searchRef = useRef(search);
  const didRestoreThreadRef = useRef(false);
  const settingsVisibleRef = useRef(false);
  const settingsCloseTimerRef = useRef<number | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId]
  );

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
    return () => {
      if (settingsCloseTimerRef.current) {
        window.clearTimeout(settingsCloseTimerRef.current);
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

  function handleServerMessage(message: ServerMessage) {
    if (message.type === "connection") {
      setConnection(message.status);
      setCodexStatus(message.status);
      if (message.status !== "connected") {
        setLoadingThreadId("");
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
      if (message.result) {
        setCliStatus(message.result);
      }
      return;
    }

    if (message.type === "threads") {
      setThreads(message.result.data || []);
      return;
    }

    if (message.type === "thread") {
      setActiveThread(message.result.thread);
      setMessages(threadToMessages(message.result.thread));
      setLoadingThreadId("");
      setOpenStepGroups({});
      setBusy(false);
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
        setLogs((current) =>
          [`Чат скрыт локально. Архив Codex: ${message.archiveError}`, ...current]
            .filter(Boolean)
            .slice(0, 20)
        );
      }
      return;
    }

    if (message.type === "turn") {
      setBusy(true);
      return;
    }

    if (message.type === "log") {
      setLogs((current) => [message.line.trim(), ...current].filter(Boolean).slice(0, 20));
      return;
    }

    if (message.type === "error") {
      setError(message.message);
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
    }

    if (method === "item/started" && params.item) {
      const next = itemToMessage(params.item);
      if (next) setMessages((current) => upsertMessage(current, next));
    }

    if (method === "item/agentMessage/delta") {
      setMessages((current) =>
        upsertMessage(
          current,
          { id: params.itemId, role: "assistant", text: params.delta || "" },
          true
        )
      );
    }

    if (method === "item/plan/delta") {
      setMessages((current) =>
        upsertMessage(
          current,
          { id: params.itemId, role: "assistant", title: "План", text: params.delta || "" },
          true
        )
      );
    }

    if (method === "item/commandExecution/outputDelta") {
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
      if (next) setMessages((current) => upsertMessage(current, next));
    }

    if (method === "turn/completed") {
      setBusy(false);
      notifyCompletion();
      if (preferencesRef.current.autoRefreshHistory) {
        send({ type: "listThreads", searchTerm: searchRef.current });
      }
    }
  }

  function connectProject(profileId = selectedProfileId) {
    if (!profileId) {
      setProfileOpen(true);
      return;
    }
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
    const menuHeight = 142;
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
    setCliPhase("updating");
    send({
      type: "updateCodexCli",
      profileId: selectedProfileId,
      password: sessionPasswords[selectedProfileId] || undefined
    });
  }

  function disconnect() {
    send({ type: "disconnect" });
    setConnection("idle");
    setBusy(false);
    setLoadingThreadId("");
  }

  function selectThread(thread: CodexThread) {
    setActiveThread(thread);
    setMessages([]);
    setLoadingThreadId(thread.id);
    setOpenStepGroups({});
    send({ type: "readThread", threadId: thread.id });
  }

  function newThread() {
    setActiveThread(null);
    setMessages([]);
    setLoadingThreadId("");
    setOpenStepGroups({});
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

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || connection !== "connected") return;

    setError("");
    setInput("");
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: "user", text }
    ]);
    send({
      type: "sendMessage",
      threadId: activeThread?.id,
      text
    });
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

  const canSend = connection === "connected" && input.trim().length > 0;
  const isCliWorking = cliPhase === "checking" || cliPhase === "updating";
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
    [connection, isCliWorking, selectedProfile, selectedProfileId]
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
            <button onClick={() => setError("")}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className={loadingThreadId || messages.length === 0 ? "messages empty" : "messages"}>
          {loadingThreadId ? (
            <div className="thread-loading-state">
              <Loader2 size={26} className="spin" />
              <h2>Загружаю чат</h2>
              <p>Поднимаю историю с сервера.</p>
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
                                    <span>{message.title || messageRoleLabel[message.role]}</span>
                                    <p>{previewText(message.text) || "Без текста"}</p>
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
                            <span key={file.key} className="file-summary-chip" title={file.path}>
                              {file.operation && <small>{file.operation}</small>}
                              {file.label}
                            </span>
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

        <form className="composer" onSubmit={submit}>
          <div className="composer-box">
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
                <button type="button" className="send-button stop" onClick={() => send({ type: "interrupt" })} title="Остановить">
                  <Square size={15} />
                </button>
              ) : (
                <button className="send-button" disabled={!canSend} title="Отправить">
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
                    Показать папки
                  </button>
                </div>

                <div className="quick-paths">
                  <button type="button" onClick={() => void loadDirectories("~")}>~</button>
                  <button type="button" onClick={() => void loadDirectories("/var/www")}>/var/www</button>
                  <button type="button" onClick={() => void loadDirectories("/home")}>/home</button>
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
                          Показать папки
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
                Команда обновления Codex
                <input
                  value={draft.updateCommand ?? ""}
                  onChange={(event) => updateDraft({ updateCommand: event.target.value })}
                  placeholder={preferences.defaultUpdateCommand}
                  autoComplete="off"
                />
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
              Чат исчезнет из списка. Если текущая версия Codex поддерживает архивирование,
              он также будет архивирован на сервере.
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
                  <strong>{cliStatus?.installed || "не проверено"}</strong>
                </div>
                <div>
                  <span>Новая версия</span>
                  <strong>{cliStatus?.latest || "-"}</strong>
                </div>
                <button className="secondary-button" onClick={checkCodexCli} disabled={!selectedProfileId || isCliWorking}>
                  {cliPhase === "checking" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                  Проверить
                </button>
                <button
                  className="primary-button"
                  onClick={updateCodexCli}
                  disabled={!selectedProfileId || isCliWorking || !cliStatus?.updateAvailable}
                >
                  {cliPhase === "updating" ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                  Обновить
                </button>
              </div>
              <label>
                Команда обновления по умолчанию
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
                  <strong>{cliStatus?.installed || "не проверено"}</strong>
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
