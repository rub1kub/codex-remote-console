import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Container,
  Cpu,
  FileClock,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  ListTree,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  SquareTerminal,
  Upload,
  X
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

export type ProjectWorkbenchProps = {
  open: boolean;
  profileId: string;
  password?: string;
  projectName: string;
  onClose: () => void;
};

type WorkbenchTab = "git" | "runtime" | "instructions";
type Feedback = { tone: "error" | "success"; message: string };
type GitAction = "stage" | "unstage" | "commit" | "push" | null;

type GitStatusEntry = {
  path: string;
  originalPath?: string;
  kind: "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
};

type GitBranchStatus = {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
};

type ProjectGitStatus = {
  branch: GitBranchStatus;
  files: GitStatusEntry[];
};

type GitBranchItem = {
  name: string;
  fullName: string;
  kind: "local" | "remote";
  current: boolean;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
};

type GitCommitResult = {
  commit: string;
  status: ProjectGitStatus;
  stdout: string;
  stderr: string;
};

type GitPushResult = {
  branch: string;
  remote: string;
  remoteBranch: string;
  setUpstream: boolean;
  stdout: string;
  stderr: string;
};

type RuntimeProcess = {
  pid: number;
  parentPid: number;
  user: string;
  elapsed: string;
  cpuPercent: number;
  memoryPercent: number;
  command: string;
};

type RuntimeLogFile = {
  path: string;
  size: number;
  modifiedAt: number;
};

type RuntimeService = {
  id: string;
  name: string;
  status: string;
  detail?: string;
};

type RuntimeServiceProvider = {
  available: boolean;
  exitCode: number | null;
  services: RuntimeService[];
  raw: string;
};

type ProjectRuntimeSnapshot = {
  capturedAt: string;
  processes: RuntimeProcess[];
  logs: RuntimeLogFile[];
  services: {
    systemctl: RuntimeServiceProvider;
    pm2: RuntimeServiceProvider;
    docker: RuntimeServiceProvider;
  };
};

type RootAgentsFile = {
  exists: boolean;
  content: string;
  size: number;
  revision: string;
};

type ApiErrorBody = {
  error?: string;
  currentRevision?: string;
};

const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024;
const MAX_AGENTS_FILE_BYTES = 128 * 1024;

const tabs: Array<{
  id: WorkbenchTab;
  label: string;
  icon: typeof GitBranch;
}> = [
  { id: "git", label: "Git", icon: GitBranch },
  { id: "runtime", label: "Сервер", icon: Server },
  { id: "instructions", label: "Инструкции", icon: FileText }
];

const serviceProviders: Array<{
  id: keyof ProjectRuntimeSnapshot["services"];
  label: string;
  icon: typeof Server;
}> = [
  { id: "systemctl", label: "systemd", icon: Server },
  { id: "pm2", label: "PM2", icon: SquareTerminal },
  { id: "docker", label: "Docker", icon: Container }
];

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

class ProjectApiError extends Error {
  readonly currentRevision?: string;

  constructor(message: string, currentRevision?: string) {
    super(message);
    this.name = "ProjectApiError";
    this.currentRevision = currentRevision;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function requestJson<T>(
  endpoint: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ProjectApiError("Не удалось связаться с сервером проекта.");
  }

  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProjectApiError(
        response.ok
          ? "Сервер вернул некорректный ответ."
          : `Запрос завершился с ошибкой ${response.status}.`
      );
    }
  }

  if (!response.ok) {
    const errorBody = isRecord(data) ? data as ApiErrorBody : {};
    throw new ProjectApiError(
      typeof errorBody.error === "string" && errorBody.error
        ? errorBody.error
        : `Запрос завершился с ошибкой ${response.status}.`,
      typeof errorBody.currentRevision === "string"
        ? errorBody.currentRevision
        : undefined
    );
  }

  return data as T;
}

function requiredPayload<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === null) throw new ProjectApiError(message);
  return value;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function utf8Size(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
  return `${(bytes / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}

function formatDate(value: string | number) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

function isoDateFromEpoch(value: number) {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function shortRevision(revision: string) {
  if (revision === "missing") return "новый файл";
  return revision.startsWith("sha256:") ? revision.slice(7, 19) : revision;
}

function gitStatusLabel(file: GitStatusEntry) {
  if (file.kind === "unmerged") return "конфликт";
  if (file.kind === "untracked") return "новый";
  if (file.kind === "ignored") return "игнорируется";
  if (file.kind === "renamed") return "переименован";
  if (file.indexStatus === "D" || file.worktreeStatus === "D") return "удалён";
  if (file.indexStatus === "A") return "добавлен";
  return "изменён";
}

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  const Icon = feedback.tone === "error" ? AlertCircle : CheckCircle2;
  return (
    <div
      className={`project-workbench-feedback ${feedback.tone}`}
      role={feedback.tone === "error" ? "alert" : "status"}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{feedback.message}</span>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="project-workbench-loading" role="status">
      <Loader2 className="spin" size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ProjectWorkbench({
  open,
  profileId,
  password,
  projectName,
  onClose
}: ProjectWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("git");
  const [feedback, setFeedback] = useState<Record<WorkbenchTab, Feedback | null>>({
    git: null,
    runtime: null,
    instructions: null
  });

  const [gitStatus, setGitStatus] = useState<ProjectGitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchItem[]>([]);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitAction, setGitAction] = useState<GitAction>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [pushConfirmation, setPushConfirmation] = useState(false);

  const [runtime, setRuntime] = useState<ProjectRuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);

  const [agentsFile, setAgentsFile] = useState<RootAgentsFile | null>(null);
  const [agentsContent, setAgentsContent] = useState("");
  const [instructionsLoading, setInstructionsLoading] = useState(false);
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionConflict, setInstructionConflict] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"close" | "reload" | null>(null);

  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const requestIdentity = `${profileId}\u0000${password ?? ""}`;
  const requestIdentityRef = useRef(requestIdentity);
  requestIdentityRef.current = requestIdentity;

  const apiBody = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      profileId,
      password: password ?? "",
      ...extra
    }),
    [password, profileId]
  );

  const setTabFeedback = useCallback((tab: WorkbenchTab, next: Feedback | null) => {
    setFeedback((current) => ({ ...current, [tab]: next }));
  }, []);

  const loadGit = useCallback(async (signal?: AbortSignal, announce = false) => {
    const identity = requestIdentity;
    setGitLoading(true);
    setTabFeedback("git", null);
    try {
      const [statusResponse, branchesResponse] = await Promise.all([
        requestJson<{ status?: ProjectGitStatus }>(
          "/api/project/git/status",
          "POST",
          apiBody(),
          signal
        ),
        requestJson<{ branches?: GitBranchItem[] }>(
          "/api/project/git/branches",
          "POST",
          apiBody(),
          signal
        )
      ]);
      const nextStatus = requiredPayload(statusResponse.status, "В ответе отсутствует статус Git.");
      const nextBranches = requiredPayload(branchesResponse.branches, "В ответе отсутствует список веток.");
      if (requestIdentityRef.current !== identity || signal?.aborted) return;
      setGitStatus(nextStatus);
      setBranches(nextBranches);
      setSelectedPaths((current) => current.filter((path) => nextStatus.files.some((file) => file.path === path)));
      if (announce) {
        setTabFeedback("git", { tone: "success", message: "Статус Git обновлён." });
      }
    } catch (error) {
      if (isAbortError(error) || requestIdentityRef.current !== identity) return;
      setTabFeedback("git", {
        tone: "error",
        message: errorMessage(error, "Не удалось загрузить статус Git.")
      });
    } finally {
      if (requestIdentityRef.current === identity && !signal?.aborted) setGitLoading(false);
    }
  }, [apiBody, requestIdentity, setTabFeedback]);

  const loadRuntime = useCallback(async (signal?: AbortSignal, announce = false) => {
    const identity = requestIdentity;
    setRuntimeLoading(true);
    setTabFeedback("runtime", null);
    try {
      const response = await requestJson<{ runtime?: ProjectRuntimeSnapshot }>(
        "/api/project/runtime",
        "POST",
        apiBody(),
        signal
      );
      const nextRuntime = requiredPayload(response.runtime, "В ответе отсутствует снимок сервера.");
      if (requestIdentityRef.current !== identity || signal?.aborted) return;
      setRuntime(nextRuntime);
      if (announce) {
        setTabFeedback("runtime", { tone: "success", message: "Состояние сервера обновлено." });
      }
    } catch (error) {
      if (isAbortError(error) || requestIdentityRef.current !== identity) return;
      setTabFeedback("runtime", {
        tone: "error",
        message: errorMessage(error, "Не удалось загрузить состояние сервера.")
      });
    } finally {
      if (requestIdentityRef.current === identity && !signal?.aborted) setRuntimeLoading(false);
    }
  }, [apiBody, requestIdentity, setTabFeedback]);

  const loadInstructions = useCallback(async (signal?: AbortSignal, announce = false) => {
    const identity = requestIdentity;
    setInstructionsLoading(true);
    setTabFeedback("instructions", null);
    try {
      const response = await requestJson<{ file?: RootAgentsFile }>(
        "/api/project/instructions",
        "POST",
        apiBody(),
        signal
      );
      const nextFile = requiredPayload(response.file, "В ответе отсутствует файл AGENTS.md.");
      if (requestIdentityRef.current !== identity || signal?.aborted) return;
      setAgentsFile(nextFile);
      setAgentsContent(nextFile.content);
      setInstructionConflict(null);
      if (announce) {
        setTabFeedback("instructions", {
          tone: "success",
          message: nextFile.exists ? "AGENTS.md загружен заново." : "AGENTS.md пока не создан."
        });
      }
    } catch (error) {
      if (isAbortError(error) || requestIdentityRef.current !== identity) return;
      setTabFeedback("instructions", {
        tone: "error",
        message: errorMessage(error, "Не удалось загрузить AGENTS.md.")
      });
    } finally {
      if (requestIdentityRef.current === identity && !signal?.aborted) setInstructionsLoading(false);
    }
  }, [apiBody, requestIdentity, setTabFeedback]);

  useEffect(() => {
    setActiveTab("git");
    setFeedback({ git: null, runtime: null, instructions: null });
    setGitStatus(null);
    setBranches([]);
    setGitLoading(false);
    setGitAction(null);
    setSelectedPaths([]);
    setCommitMessage("");
    setPushConfirmation(false);
    setRuntime(null);
    setRuntimeLoading(false);
    setAgentsFile(null);
    setAgentsContent("");
    setInstructionsLoading(false);
    setInstructionsSaving(false);
    setInstructionConflict(null);
    setConfirmation(null);
  }, [requestIdentity]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    if (activeTab === "git" && !gitStatus) void loadGit(controller.signal);
    if (activeTab === "runtime" && !runtime) void loadRuntime(controller.signal);
    if (activeTab === "instructions" && !agentsFile) void loadInstructions(controller.signal);
    return () => controller.abort();
  }, [activeTab, agentsFile, gitStatus, loadGit, loadInstructions, loadRuntime, open, runtime]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  const selectablePaths = useMemo(
    () => gitStatus?.files.filter((file) => file.kind !== "ignored").map((file) => file.path) ?? [],
    [gitStatus]
  );
  const allFilesSelected = selectablePaths.length > 0 && selectablePaths.every((path) => selectedPaths.includes(path));
  const stagedSelectedPaths = gitStatus?.files
    .filter((file) => file.staged && selectedPaths.includes(file.path))
    .map((file) => file.path) ?? [];
  const unstagedSelectedPaths = gitStatus?.files
    .filter((file) => file.unstaged && selectedPaths.includes(file.path))
    .map((file) => file.path) ?? [];
  const stagedCount = gitStatus?.files.filter((file) => file.staged).length ?? 0;
  const agentsDirty = Boolean(agentsFile && agentsContent !== agentsFile.content);
  const agentsBytes = utf8Size(agentsContent);
  const agentsTooLarge = agentsBytes > MAX_AGENTS_FILE_BYTES;
  const commitBytes = utf8Size(commitMessage.trim());
  const commitTooLarge = commitBytes > MAX_COMMIT_MESSAGE_BYTES;
  const currentFeedback = feedback[activeTab];
  const isMutating = gitAction !== null || instructionsSaving;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedPaths.length > 0 && !allFilesSelected;
    }
  }, [allFilesSelected, selectedPaths.length]);

  function requestClose() {
    if (isMutating) return;
    if (agentsDirty) {
      setConfirmation("close");
      return;
    }
    onClose();
  }

  function selectTab(tab: WorkbenchTab) {
    setActiveTab(tab);
    setPushConfirmation(false);
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") nextIndex = index === 0 ? tabs.length - 1 : index - 1;
    if (event.key === "ArrowRight") nextIndex = index === tabs.length - 1 ? 0 : index + 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectTab(tabs[nextIndex].id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]
      ?.focus();
  }

  function handleLayerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirmation) setConfirmation(null);
      else if (pushConfirmation) setPushConfirmation(false);
      else requestClose();
      return;
    }
    if (event.key !== "Tab" || !drawerRef.current) return;

    const focusRoot = confirmation
      ? drawerRef.current.querySelector<HTMLElement>(".project-workbench-confirmation-overlay")
      : drawerRef.current;
    if (!focusRoot) return;
    const focusable = Array.from(focusRoot.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"
    )).filter((element) => !element.hasAttribute("hidden"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function togglePath(path: string, checked: boolean) {
    setSelectedPaths((current) => checked
      ? [...current.filter((item) => item !== path), path]
      : current.filter((item) => item !== path));
  }

  async function updateIndex(action: "stage" | "unstage", paths: string[]) {
    if (!paths.length || gitAction) return;
    const identity = requestIdentity;
    setGitAction(action);
    setTabFeedback("git", null);
    try {
      const response = await requestJson<{ status?: ProjectGitStatus }>(
        `/api/project/git/${action}`,
        "POST",
        apiBody({ paths })
      );
      const nextStatus = requiredPayload(response.status, "В ответе отсутствует статус Git.");
      if (requestIdentityRef.current !== identity) return;
      setGitStatus(nextStatus);
      setSelectedPaths([]);
      setTabFeedback("git", {
        tone: "success",
        message: action === "stage"
          ? `Добавлено в индекс: ${paths.length}.`
          : `Убрано из индекса: ${paths.length}.`
      });
    } catch (error) {
      if (requestIdentityRef.current !== identity) return;
      setTabFeedback("git", {
        tone: "error",
        message: errorMessage(error, action === "stage" ? "Не удалось добавить файлы в индекс." : "Не удалось убрать файлы из индекса.")
      });
    } finally {
      if (requestIdentityRef.current === identity) setGitAction(null);
    }
  }

  async function refreshBranchesQuietly(identity: string) {
    try {
      const response = await requestJson<{ branches?: GitBranchItem[] }>(
        "/api/project/git/branches",
        "POST",
        apiBody()
      );
      if (requestIdentityRef.current === identity && response.branches) setBranches(response.branches);
    } catch {
      // Branch metadata is supplementary after a successful mutation.
    }
  }

  async function commitChanges(event: FormEvent) {
    event.preventDefault();
    const message = commitMessage.trim();
    if (!message || stagedCount === 0 || commitTooLarge || gitAction) return;
    const identity = requestIdentity;
    setGitAction("commit");
    setTabFeedback("git", null);
    try {
      const response = await requestJson<{ commit?: GitCommitResult }>(
        "/api/project/git/commit",
        "POST",
        apiBody({ message })
      );
      const result = requiredPayload(response.commit, "В ответе отсутствует созданный коммит.");
      if (requestIdentityRef.current !== identity) return;
      setGitStatus(result.status);
      setSelectedPaths([]);
      setCommitMessage("");
      setTabFeedback("git", {
        tone: "success",
        message: `Создан коммит ${result.commit.slice(0, 12)}.`
      });
      void refreshBranchesQuietly(identity);
    } catch (error) {
      if (requestIdentityRef.current !== identity) return;
      setTabFeedback("git", {
        tone: "error",
        message: errorMessage(error, "Не удалось создать коммит.")
      });
    } finally {
      if (requestIdentityRef.current === identity) setGitAction(null);
    }
  }

  async function pushBranch() {
    if (gitAction) return;
    const identity = requestIdentity;
    setPushConfirmation(false);
    setGitAction("push");
    setTabFeedback("git", null);
    try {
      const response = await requestJson<{ push?: GitPushResult }>(
        "/api/project/git/push",
        "POST",
        apiBody()
      );
      const result = requiredPayload(response.push, "В ответе отсутствует результат push.");
      if (requestIdentityRef.current !== identity) return;
      setTabFeedback("git", {
        tone: "success",
        message: `Ветка ${result.branch} отправлена в ${result.remote}/${result.remoteBranch}.`
      });
      try {
        const statusResponse = await requestJson<{ status?: ProjectGitStatus }>(
          "/api/project/git/status",
          "POST",
          apiBody()
        );
        if (requestIdentityRef.current === identity && statusResponse.status) {
          setGitStatus(statusResponse.status);
        }
      } catch {
        // Push already succeeded; a manual refresh remains available.
      }
      void refreshBranchesQuietly(identity);
    } catch (error) {
      if (requestIdentityRef.current !== identity) return;
      setTabFeedback("git", {
        tone: "error",
        message: errorMessage(error, "Не удалось отправить ветку.")
      });
    } finally {
      if (requestIdentityRef.current === identity) setGitAction(null);
    }
  }

  function requestInstructionsReload() {
    if (agentsDirty) {
      setConfirmation("reload");
      return;
    }
    void loadInstructions(undefined, true);
  }

  async function saveInstructions() {
    if (!agentsFile || !agentsDirty || agentsTooLarge || instructionsSaving) return;
    const identity = requestIdentity;
    setInstructionsSaving(true);
    setInstructionConflict(null);
    setTabFeedback("instructions", null);
    try {
      const response = await requestJson<{ file?: RootAgentsFile }>(
        "/api/project/instructions",
        "PUT",
        apiBody({ content: agentsContent, expectedRevision: agentsFile.revision })
      );
      const nextFile = requiredPayload(response.file, "В ответе отсутствует сохранённый AGENTS.md.");
      if (requestIdentityRef.current !== identity) return;
      setAgentsFile(nextFile);
      setAgentsContent(nextFile.content);
      setTabFeedback("instructions", {
        tone: "success",
        message: `AGENTS.md сохранён, ревизия ${shortRevision(nextFile.revision)}.`
      });
    } catch (error) {
      if (requestIdentityRef.current !== identity) return;
      if (error instanceof ProjectApiError && error.currentRevision) {
        setInstructionConflict(error.currentRevision);
        setTabFeedback("instructions", {
          tone: "error",
          message: "AGENTS.md изменился после загрузки. Текст не перезаписан; загрузите актуальную версию."
        });
      } else {
        setTabFeedback("instructions", {
          tone: "error",
          message: errorMessage(error, "Не удалось сохранить AGENTS.md.")
        });
      }
    } finally {
      if (requestIdentityRef.current === identity) setInstructionsSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="project-workbench-layer"
      role="presentation"
      onKeyDown={handleLayerKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <aside
        ref={drawerRef}
        className="project-workbench"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-workbench-title"
        aria-busy={isMutating || undefined}
      >
        <header className="project-workbench-head">
          <div className="project-workbench-heading">
            <span>Проект</span>
            <h2 id="project-workbench-title" title={projectName}>{projectName}</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button project-workbench-close"
            onClick={requestClose}
            disabled={isMutating}
            aria-label="Закрыть панель проекта"
            title="Закрыть"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <nav className="project-workbench-tabs" role="tablist" aria-label="Разделы проекта">
          {tabs.map((tab, index) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`project-workbench-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`project-workbench-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                className={`project-workbench-tab${selected ? " active" : ""}`}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{tab.label}</span>
                {tab.id === "instructions" && agentsDirty && (
                  <span className="project-workbench-dirty-dot" aria-label="Есть несохранённые изменения" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="project-workbench-body">
          {currentFeedback && <FeedbackBanner feedback={currentFeedback} />}

          {activeTab === "git" && (
            <section
              id="project-workbench-panel-git"
              className="project-workbench-panel project-workbench-git"
              role="tabpanel"
              aria-labelledby="project-workbench-tab-git"
            >
              <div className="project-workbench-toolbar">
                <div className="project-workbench-branch-summary">
                  <GitBranch size={17} aria-hidden="true" />
                  <div>
                    <strong>{gitStatus?.branch.head || "Нет ветки"}</strong>
                    <span>{gitStatus?.branch.upstream || "Upstream не задан"}</span>
                  </div>
                </div>
                <div className="project-workbench-toolbar-actions">
                  {gitStatus && (gitStatus.branch.ahead > 0 || gitStatus.branch.behind > 0) && (
                    <span className="project-workbench-sync-badge">
                      ↑{gitStatus.branch.ahead} ↓{gitStatus.branch.behind}
                    </span>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => void loadGit(undefined, true)}
                    disabled={gitLoading || Boolean(gitAction)}
                    aria-label="Обновить статус Git"
                    title="Обновить"
                  >
                    <RefreshCw className={gitLoading ? "spin" : undefined} size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>

              {gitLoading && !gitStatus ? (
                <LoadingState label="Читаю статус Git…" />
              ) : gitStatus ? (
                <>
                  <div className="project-workbench-selection-bar">
                    <label className="project-workbench-select-all">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allFilesSelected}
                        disabled={selectablePaths.length === 0 || Boolean(gitAction)}
                        onChange={(event) => setSelectedPaths(event.target.checked ? selectablePaths : [])}
                      />
                      <span>Выбрать все</span>
                    </label>
                    <div className="project-workbench-selection-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void updateIndex("stage", unstagedSelectedPaths)}
                        disabled={!unstagedSelectedPaths.length || Boolean(gitAction)}
                      >
                        {gitAction === "stage" ? <Loader2 className="spin" size={14} /> : <GitCommitHorizontal size={14} />}
                        В индекс {unstagedSelectedPaths.length || ""}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void updateIndex("unstage", stagedSelectedPaths)}
                        disabled={!stagedSelectedPaths.length || Boolean(gitAction)}
                      >
                        {gitAction === "unstage" ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
                        Убрать {stagedSelectedPaths.length || ""}
                      </button>
                    </div>
                  </div>

                  <div className="project-workbench-file-list" aria-label="Изменённые файлы">
                    {gitStatus.files.length === 0 ? (
                      <div className="project-workbench-empty compact">
                        <CheckCircle2 size={19} aria-hidden="true" />
                        <span>Рабочее дерево чистое</span>
                      </div>
                    ) : gitStatus.files.map((file) => {
                      const checked = selectedPaths.includes(file.path);
                      const statusCode = `${file.indexStatus === "." ? " " : file.indexStatus}${file.worktreeStatus === "." ? " " : file.worktreeStatus}`;
                      return (
                        <label key={file.path} className={`project-workbench-file-row${checked ? " selected" : ""}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={file.kind === "ignored" || Boolean(gitAction)}
                            onChange={(event) => togglePath(file.path, event.target.checked)}
                            aria-label={`Выбрать ${file.path}`}
                          />
                          <code className="project-workbench-status-code" title="Индекс / рабочее дерево">
                            {statusCode}
                          </code>
                          <span className="project-workbench-file-name" title={file.path}>
                            {file.path}
                            {file.originalPath && <small>из {file.originalPath}</small>}
                          </span>
                          <span className={`project-workbench-file-kind ${file.kind}`}>
                            {gitStatusLabel(file)}
                          </span>
                          <span className="project-workbench-file-flags">
                            {file.staged && <small className="staged">индекс</small>}
                            {file.unstaged && <small>локально</small>}
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <form className="project-workbench-commit" onSubmit={commitChanges}>
                    <label htmlFor="project-workbench-commit-message">Сообщение коммита</label>
                    <textarea
                      id="project-workbench-commit-message"
                      value={commitMessage}
                      rows={3}
                      placeholder="Кратко опишите изменение"
                      disabled={Boolean(gitAction)}
                      onChange={(event) => setCommitMessage(event.target.value)}
                    />
                    <div className="project-workbench-form-meta">
                      <span className={commitTooLarge ? "limit-exceeded" : undefined}>
                        {formatBytes(commitBytes)} / 16 КБ
                      </span>
                      <span>В индексе: {stagedCount}</span>
                    </div>
                    <div className="project-workbench-commit-actions">
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={!commitMessage.trim() || stagedCount === 0 || commitTooLarge || Boolean(gitAction)}
                      >
                        {gitAction === "commit" ? <Loader2 className="spin" size={15} /> : <GitCommitHorizontal size={15} />}
                        Создать коммит
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          Boolean(gitAction) ||
                          !gitStatus.branch.head ||
                          gitStatus.branch.head === "(detached)"
                        }
                        onClick={() => setPushConfirmation(true)}
                      >
                        <Upload size={15} aria-hidden="true" />
                        Push
                      </button>
                    </div>
                  </form>

                  {pushConfirmation && (
                    <div className="project-workbench-confirmation inline" role="alertdialog" aria-labelledby="push-confirmation-title">
                      <AlertTriangle size={19} aria-hidden="true" />
                      <div>
                        <strong id="push-confirmation-title">Отправить текущую ветку?</strong>
                        <p>
                          Ветка <code>{gitStatus.branch.head}</code> будет отправлена в настроенный remote.
                        </p>
                        <div className="project-workbench-confirmation-actions">
                          <button type="button" className="secondary-button" onClick={() => setPushConfirmation(false)} autoFocus>
                            Отмена
                          </button>
                          <button type="button" className="primary-button" onClick={() => void pushBranch()}>
                            <Upload size={15} aria-hidden="true" />
                            Подтвердить push
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <details className="project-workbench-branches">
                    <summary>
                      <ListTree size={15} aria-hidden="true" />
                      Ветки <span>{branches.length}</span>
                    </summary>
                    <div className="project-workbench-branch-list">
                      {branches.length === 0 ? (
                        <span className="project-workbench-muted">Ветки не найдены.</span>
                      ) : branches.map((branch) => (
                        <div key={branch.fullName} className={`project-workbench-branch-row${branch.current ? " current" : ""}`}>
                          <GitBranch size={14} aria-hidden="true" />
                          <span title={branch.fullName}>{branch.name}</span>
                          <small>{branch.kind === "local" ? "локальная" : "remote"}</small>
                          {(branch.ahead > 0 || branch.behind > 0) && (
                            <code>↑{branch.ahead} ↓{branch.behind}</code>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                </>
              ) : (
                <div className="project-workbench-empty">
                  <AlertCircle size={20} aria-hidden="true" />
                  <span>Статус Git не загружен.</span>
                  <button type="button" className="secondary-button" onClick={() => void loadGit(undefined, true)}>
                    Повторить
                  </button>
                </div>
              )}
            </section>
          )}

          {activeTab === "runtime" && (
            <section
              id="project-workbench-panel-runtime"
              className="project-workbench-panel project-workbench-runtime"
              role="tabpanel"
              aria-labelledby="project-workbench-tab-runtime"
            >
              <div className="project-workbench-toolbar">
                <div className="project-workbench-section-title">
                  <Server size={17} aria-hidden="true" />
                  <div>
                    <strong>Состояние сервера</strong>
                    <span>{runtime ? `Снимок: ${formatDate(runtime.capturedAt)}` : "Нет данных"}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void loadRuntime(undefined, true)}
                  disabled={runtimeLoading}
                  aria-label="Обновить состояние сервера"
                  title="Обновить"
                >
                  <RefreshCw className={runtimeLoading ? "spin" : undefined} size={16} aria-hidden="true" />
                </button>
              </div>

              {runtimeLoading && !runtime ? (
                <LoadingState label="Собираю состояние сервера…" />
              ) : runtime ? (
                <div className="project-workbench-runtime-sections">
                  <section className="project-workbench-data-section">
                    <div className="project-workbench-data-heading">
                      <Cpu size={16} aria-hidden="true" />
                      <h3>Процессы</h3>
                      <span>{runtime.processes.length}</span>
                    </div>
                    {runtime.processes.length ? (
                      <div className="project-workbench-table-scroll">
                        <table className="project-workbench-table project-workbench-process-table">
                          <thead>
                            <tr>
                              <th>PID</th>
                              <th>CPU</th>
                              <th>RAM</th>
                              <th>Время</th>
                              <th>Команда</th>
                            </tr>
                          </thead>
                          <tbody>
                            {runtime.processes.map((process) => (
                              <tr key={`${process.pid}-${process.command}`}>
                                <td><code>{process.pid}</code><small>{process.user}</small></td>
                                <td>{process.cpuPercent.toLocaleString("ru-RU")}%</td>
                                <td>{process.memoryPercent.toLocaleString("ru-RU")}%</td>
                                <td>{process.elapsed}</td>
                                <td><code title={process.command}>{process.command}</code></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="project-workbench-empty compact">Процессы не найдены.</div>
                    )}
                  </section>

                  <section className="project-workbench-data-section">
                    <div className="project-workbench-data-heading">
                      <FileClock size={16} aria-hidden="true" />
                      <h3>Логи</h3>
                      <span>{runtime.logs.length}</span>
                    </div>
                    {runtime.logs.length ? (
                      <div className="project-workbench-log-list">
                        {runtime.logs.map((log) => (
                          <div key={log.path} className="project-workbench-log-row">
                            <FileText size={15} aria-hidden="true" />
                            <span title={log.path}>{log.path}</span>
                            <small>{formatBytes(log.size)}</small>
                            <time dateTime={isoDateFromEpoch(log.modifiedAt)}>
                              {formatDate(log.modifiedAt)}
                            </time>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="project-workbench-empty compact">Файлы логов не найдены.</div>
                    )}
                  </section>

                  <section className="project-workbench-data-section">
                    <div className="project-workbench-data-heading">
                      <HardDrive size={16} aria-hidden="true" />
                      <h3>Сервисы</h3>
                    </div>
                    <div className="project-workbench-service-grid">
                      {serviceProviders.map((providerInfo) => {
                        const provider = runtime.services[providerInfo.id];
                        const Icon = providerInfo.icon;
                        return (
                          <article key={providerInfo.id} className={`project-workbench-service-provider${provider.available ? " available" : " unavailable"}`}>
                            <header>
                              <Icon size={16} aria-hidden="true" />
                              <strong>{providerInfo.label}</strong>
                              <span>
                                {!provider.available
                                  ? "не установлен"
                                  : provider.exitCode === 0
                                    ? `${provider.services.length}`
                                    : `ошибка ${provider.exitCode}`}
                              </span>
                            </header>
                            {provider.services.length > 0 ? (
                              <div className="project-workbench-service-list">
                                {provider.services.map((service) => (
                                  <div key={`${providerInfo.id}-${service.id}`} className="project-workbench-service-row">
                                    <span className="project-workbench-service-status" aria-hidden="true" />
                                    <div>
                                      <strong>{service.name}</strong>
                                      <small>{service.status}{service.detail ? ` · ${service.detail}` : ""}</small>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : provider.available && provider.exitCode === 0 ? (
                              <span className="project-workbench-muted">Активных сервисов нет.</span>
                            ) : provider.available && provider.raw ? (
                              <pre className="project-workbench-provider-error">{provider.raw}</pre>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="project-workbench-empty">
                  <AlertCircle size={20} aria-hidden="true" />
                  <span>Состояние сервера не загружено.</span>
                  <button type="button" className="secondary-button" onClick={() => void loadRuntime(undefined, true)}>
                    Повторить
                  </button>
                </div>
              )}
            </section>
          )}

          {activeTab === "instructions" && (
            <section
              id="project-workbench-panel-instructions"
              className="project-workbench-panel project-workbench-instructions"
              role="tabpanel"
              aria-labelledby="project-workbench-tab-instructions"
            >
              <div className="project-workbench-toolbar">
                <div className="project-workbench-section-title">
                  <FileText size={17} aria-hidden="true" />
                  <div>
                    <strong>AGENTS.md</strong>
                    <span>
                      {agentsFile
                        ? `${agentsFile.exists ? "Файл проекта" : "Новый файл"} · ${shortRevision(agentsFile.revision)}`
                        : "Нет данных"}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={requestInstructionsReload}
                  disabled={instructionsLoading || instructionsSaving}
                  aria-label="Загрузить AGENTS.md заново"
                  title="Загрузить заново"
                >
                  <RefreshCw className={instructionsLoading ? "spin" : undefined} size={16} aria-hidden="true" />
                </button>
              </div>

              {instructionsLoading && !agentsFile ? (
                <LoadingState label="Загружаю AGENTS.md…" />
              ) : agentsFile ? (
                <div className="project-workbench-editor-shell">
                  <div className="project-workbench-editor-meta">
                    <span className={`project-workbench-editor-state${agentsDirty ? " dirty" : ""}`}>
                      {agentsDirty ? "Не сохранено" : "Сохранено"}
                    </span>
                    <span title={agentsFile.revision}>Ревизия: {shortRevision(agentsFile.revision)}</span>
                    <span className={agentsTooLarge ? "limit-exceeded" : undefined}>
                      {formatBytes(agentsBytes)} / 128 КБ
                    </span>
                  </div>
                  <textarea
                    className="project-workbench-editor"
                    value={agentsContent}
                    disabled={instructionsSaving}
                    spellCheck={false}
                    aria-label="Содержимое AGENTS.md"
                    onChange={(event) => {
                      setAgentsContent(event.target.value);
                      setInstructionConflict(null);
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                        event.preventDefault();
                        void saveInstructions();
                      }
                    }}
                  />
                  {agentsTooLarge && (
                    <div className="project-workbench-limit-message" role="alert">
                      AGENTS.md превышает лимит 128 КБ. Уменьшите файл перед сохранением.
                    </div>
                  )}
                  {instructionConflict && (
                    <div className="project-workbench-conflict">
                      <AlertTriangle size={16} aria-hidden="true" />
                      <span>Текущая ревизия на сервере: {shortRevision(instructionConflict)}</span>
                      <button type="button" className="secondary-button" onClick={requestInstructionsReload}>
                        Загрузить актуальную
                      </button>
                    </div>
                  )}
                  <div className="project-workbench-editor-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!agentsDirty || instructionsSaving}
                      onClick={() => {
                        setAgentsContent(agentsFile.content);
                        setInstructionConflict(null);
                        setTabFeedback("instructions", null);
                      }}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      Отменить изменения
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!agentsDirty || agentsTooLarge || instructionsSaving}
                      onClick={() => void saveInstructions()}
                    >
                      {instructionsSaving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                      Сохранить
                    </button>
                  </div>
                </div>
              ) : (
                <div className="project-workbench-empty">
                  <AlertCircle size={20} aria-hidden="true" />
                  <span>AGENTS.md не загружен.</span>
                  <button type="button" className="secondary-button" onClick={() => void loadInstructions(undefined, true)}>
                    Повторить
                  </button>
                </div>
              )}
            </section>
          )}
        </div>

        {confirmation && (
          <div className="project-workbench-confirmation-overlay">
            <div className="project-workbench-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="workbench-confirmation-title">
              <AlertTriangle size={20} aria-hidden="true" />
              <div>
                <strong id="workbench-confirmation-title">
                  {confirmation === "close" ? "Закрыть без сохранения?" : "Загрузить файл заново?"}
                </strong>
                <p>Несохранённые изменения AGENTS.md будут потеряны.</p>
                <div className="project-workbench-confirmation-actions">
                  <button type="button" className="secondary-button" onClick={() => setConfirmation(null)} autoFocus>
                    Продолжить редактирование
                  </button>
                  <button
                    type="button"
                    className="danger-button strong"
                    onClick={() => {
                      const action = confirmation;
                      setConfirmation(null);
                      if (action === "close") onClose();
                      else void loadInstructions(undefined, true);
                    }}
                  >
                    {confirmation === "close" ? "Закрыть" : "Загрузить заново"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

export default ProjectWorkbench;
