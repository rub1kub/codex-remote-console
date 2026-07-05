import {
  ArrowUp,
  Bot,
  Check,
  Circle,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Server,
  Settings,
  Square,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type {
  ChatMessage,
  CodexProfile,
  CodexThread,
  ServerMessage,
  ThreadItem
} from "./types";

type ConnectionState = "idle" | "connecting" | "connected";
type ProfileDraft = Omit<CodexProfile, "id" | "createdAt" | "updatedAt">;

const emptyDraft: ProfileDraft = {
  name: "",
  mode: "ssh",
  sshTarget: "",
  projectPath: "",
  codexBin: "codex",
  approvalPolicy: "never",
  sandboxMode: "danger-full-access"
};

const formatDate = (seconds: number) =>
  new Intl.DateTimeFormat("ru", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(seconds * 1000));

const titleOf = (thread?: CodexThread | null) =>
  thread?.name || thread?.preview || "Новая сессия";

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

export default function App() {
  const [profiles, setProfiles] = useState<CodexProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [codexStatus, setCodexStatus] = useState("");
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [activeThread, setActiveThread] = useState<CodexThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [isProfileOpen, setProfileOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<CodexProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [isBusy, setBusy] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId]
  );

  useEffect(() => {
    void loadProfiles();
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

  async function loadProfiles() {
    const response = await fetch("/api/profiles");
    const data = (await response.json()) as { profiles: CodexProfile[] };
    setProfiles(data.profiles);
    setSelectedProfileId((current) => current || data.profiles[0]?.id || "");
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
      return;
    }

    if (message.type === "codexStatus") {
      setCodexStatus(message.status);
      return;
    }

    if (message.type === "threads") {
      setThreads(message.result.data || []);
      return;
    }

    if (message.type === "thread") {
      setActiveThread(message.result.thread);
      setMessages(threadToMessages(message.result.thread));
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
      return;
    }

    if (message.type === "notification") {
      handleNotification(message.message.method, message.message.params);
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
      send({ type: "listThreads", searchTerm: search });
    }
  }

  function connect() {
    if (!selectedProfileId) {
      setProfileOpen(true);
      return;
    }
    setError("");
    setMessages([]);
    setActiveThread(null);
    setConnection("connecting");
    send({ type: "connect", profileId: selectedProfileId });
  }

  function disconnect() {
    send({ type: "disconnect" });
    setConnection("idle");
    setBusy(false);
  }

  function selectThread(thread: CodexThread) {
    setActiveThread(thread);
    send({ type: "readThread", threadId: thread.id });
  }

  function newThread() {
    setActiveThread(null);
    setMessages([]);
    send({ type: "newThread" });
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

  function openProfile(profile?: CodexProfile) {
    setEditingProfile(profile ?? null);
    setDraft(
      profile
        ? {
            name: profile.name,
            mode: profile.mode,
            sshTarget: profile.sshTarget,
            port: profile.port,
            identityFile: profile.identityFile,
            projectPath: profile.projectPath,
            codexBin: profile.codexBin,
            model: profile.model,
            approvalPolicy: profile.approvalPolicy,
            sandboxMode: profile.sandboxMode
          }
        : emptyDraft
    );
    setProfileOpen(true);
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const url = editingProfile ? `/api/profiles/${editingProfile.id}` : "/api/profiles";
    const response = await fetch(url, {
      method: editingProfile ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft)
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Не удалось сохранить профиль.");
      return;
    }
    await loadProfiles();
    setSelectedProfileId(data.profile.id);
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

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <Bot size={18} />
          </div>
          <div>
            <strong>Codex Remote</strong>
            <span>SSH sessions</span>
          </div>
        </div>

        <section className="profile-box">
          <label>Сервер</label>
          <div className="profile-select-row">
            <select
              value={selectedProfileId}
              onChange={(event) => setSelectedProfileId(event.target.value)}
            >
              <option value="">Добавить сервер</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button className="icon-button" onClick={() => openProfile(selectedProfile)} title="Настройки сервера">
              <Settings size={16} />
            </button>
          </div>

          {selectedProfile && (
            <div className="profile-meta">
              <Server size={14} />
              <span>{selectedProfile.mode === "local" ? "local" : selectedProfile.sshTarget}</span>
              <span>{selectedProfile.projectPath}</span>
            </div>
          )}

          <button
            className="primary-button"
            onClick={connection === "connected" ? disconnect : connect}
          >
            {connection === "connecting" ? (
              <Loader2 size={16} className="spin" />
            ) : connection === "connected" ? (
              <Square size={14} />
            ) : (
              <Check size={16} />
            )}
            {connection === "connected" ? "Отключиться" : "Подключиться"}
          </button>
        </section>

        <div className="history-head">
          <div>
            <History size={15} />
            <span>История</span>
          </div>
          <button className="icon-button" onClick={newThread} title="Новая сессия" disabled={connection !== "connected"}>
            <Plus size={16} />
          </button>
        </div>

        <div className="search-box">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => refreshThreads(event.target.value)}
            placeholder="Поиск сессий"
          />
        </div>

        <div className="thread-list">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`thread-row ${activeThread?.id === thread.id ? "active" : ""}`}
              onClick={() => selectThread(thread)}
            >
              <span>{titleOf(thread)}</span>
              <small>{formatDate(thread.updatedAt)} · {thread.source}</small>
            </button>
          ))}
          {connection === "connected" && threads.length === 0 && (
            <div className="empty-note">Сессий в этой директории пока не найдено.</div>
          )}
        </div>

        <button className="text-button" onClick={() => openProfile()}>
          <Plus size={15} />
          Новый сервер
        </button>
      </aside>

      <section className="chat">
        <header className="chat-header">
          <div>
            <h1>{titleOf(activeThread)}</h1>
            <p>{selectedProfile?.projectPath || "Выберите сервер и директорию проекта"}</p>
          </div>
          <div className={`status-pill ${connection}`}>
            <Circle size={8} fill="currentColor" />
            {connection === "connected" ? "Connected" : connection === "connecting" ? "Connecting" : "Idle"}
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

        <div className="messages">
          {messages.length === 0 ? (
            <div className="welcome">
              <MessageSquare size={28} />
              <h2>Открой сессию или напиши Codex</h2>
              <p>История подтянется с сервера через app-server после подключения.</p>
            </div>
          ) : (
            messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-avatar">
                  {message.role === "tool" ? <Terminal size={15} /> : message.role === "user" ? "You" : "C"}
                </div>
                <div className="message-body">
                  {message.title && <strong>{message.title}</strong>}
                  <pre className={message.muted ? "muted" : ""}>{message.text}</pre>
                </div>
              </article>
            ))
          )}
          <div ref={endRef} />
        </div>

        <form className="composer" onSubmit={submit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={connection === "connected" ? "Напиши задачу Codex..." : "Сначала подключись к серверу"}
            disabled={connection !== "connected"}
            rows={1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(event);
              }
            }}
          />
          {isBusy ? (
            <button type="button" className="icon-button stop" onClick={() => send({ type: "interrupt" })} title="Остановить">
              <Square size={15} />
            </button>
          ) : (
            <button className="send-button" disabled={!canSend} title="Отправить">
              <ArrowUp size={17} />
            </button>
          )}
        </form>

        {logs.length > 0 && (
          <details className="diagnostics">
            <summary>Diagnostics</summary>
            {logs.map((line, index) => (
              <code key={`${line}-${index}`}>{line}</code>
            ))}
          </details>
        )}
      </section>

      {isProfileOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="profile-modal" onSubmit={saveDraft}>
            <div className="modal-head">
              <h2>{editingProfile ? "Сервер" : "Новый сервер"}</h2>
              <button type="button" className="icon-button" onClick={() => setProfileOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <label>
              Название
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="prod-box"
              />
            </label>

            <label>
              Тип
              <select
                value={draft.mode}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value as ProfileDraft["mode"] })}
              >
                <option value="ssh">SSH</option>
                <option value="local">Local</option>
              </select>
            </label>

            {draft.mode === "ssh" && (
              <>
                <label>
                  SSH target
                  <input
                    value={draft.sshTarget}
                    onChange={(event) => setDraft({ ...draft, sshTarget: event.target.value })}
                    placeholder="devbox или ubuntu@host"
                  />
                </label>
                <div className="two-fields">
                  <label>
                    Port
                    <input
                      value={draft.port ?? ""}
                      onChange={(event) => setDraft({ ...draft, port: event.target.value ? Number(event.target.value) : undefined })}
                      placeholder="22"
                    />
                  </label>
                  <label>
                    Identity file
                    <input
                      value={draft.identityFile ?? ""}
                      onChange={(event) => setDraft({ ...draft, identityFile: event.target.value })}
                      placeholder="~/.ssh/id_ed25519"
                    />
                  </label>
                </div>
              </>
            )}

            <label>
              Project path
              <input
                value={draft.projectPath}
                onChange={(event) => setDraft({ ...draft, projectPath: event.target.value })}
                placeholder="~/app"
                required
              />
            </label>

            <div className="two-fields">
              <label>
                Codex binary
                <input
                  value={draft.codexBin}
                  onChange={(event) => setDraft({ ...draft, codexBin: event.target.value })}
                  placeholder="codex"
                />
              </label>
              <label>
                Model
                <input
                  value={draft.model ?? ""}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  placeholder="default"
                />
              </label>
            </div>

            <div className="two-fields">
              <label>
                Approval
                <select
                  value={draft.approvalPolicy}
                  onChange={(event) => setDraft({ ...draft, approvalPolicy: event.target.value as ProfileDraft["approvalPolicy"] })}
                >
                  <option value="never">never</option>
                  <option value="on-request">on-request</option>
                  <option value="on-failure">on-failure</option>
                  <option value="untrusted">untrusted</option>
                </select>
              </label>
              <label>
                Sandbox
                <select
                  value={draft.sandboxMode}
                  onChange={(event) => setDraft({ ...draft, sandboxMode: event.target.value as ProfileDraft["sandboxMode"] })}
                >
                  <option value="danger-full-access">danger-full-access</option>
                  <option value="workspace-write">workspace-write</option>
                  <option value="read-only">read-only</option>
                </select>
              </label>
            </div>

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
    </main>
  );
}
