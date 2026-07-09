import {
  Bell,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CirclePause,
  Clock3,
  Inbox,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import type { WorkspaceTaskRecord, WorkspaceTaskStatus } from "./workspaceState";

export type TaskCenterFilter = "all" | "running" | "attention" | "completed";

export type TaskCenterProps = {
  open: boolean;
  tasks: readonly WorkspaceTaskRecord[];
  variant?: "drawer" | "panel";
  filter?: TaskCenterFilter;
  initialFilter?: TaskCenterFilter;
  onFilterChange?: (filter: TaskCenterFilter) => void;
  onClose?: () => void;
  onSelectTask?: (task: WorkspaceTaskRecord) => void;
  onMarkRead?: (taskId: string) => void;
  onMarkAllRead?: () => void;
  className?: string;
  style?: CSSProperties;
};

const filterOptions: Array<{ value: TaskCenterFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "running", label: "В работе" },
  { value: "attention", label: "Внимание" },
  { value: "completed", label: "Готово" }
];

const statusLabels: Record<WorkspaceTaskStatus, string> = {
  running: "В работе",
  completed: "Готово",
  failed: "Ошибка",
  interrupted: "Прервано",
  waiting: "Ожидает"
};

const layerStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: "var(--z-modal, 120)",
  display: "flex",
  justifyContent: "flex-end",
  background: "rgba(8, 12, 10, 0.3)"
};

const centerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "min(420px, calc(100vw - 16px))",
  minWidth: 0,
  minHeight: 0,
  color: "inherit",
  borderLeft: "1px solid var(--sidebar-border, #dfe3df)",
  background: "var(--chat-bg, #ffffff)",
  boxShadow: "-20px 0 60px rgba(18, 25, 21, 0.16)"
};

const panelStyle: CSSProperties = {
  ...centerStyle,
  width: "100%",
  height: "100%",
  border: "1px solid var(--sidebar-border, #dfe3df)",
  borderRadius: 8,
  boxShadow: "none"
};

const iconButtonStyle: CSSProperties = {
  display: "grid",
  width: 30,
  height: 30,
  flex: "0 0 auto",
  placeItems: "center",
  padding: 0,
  borderRadius: 7,
  background: "transparent",
  color: "inherit",
  cursor: "pointer"
};

const mutedStyle: CSSProperties = {
  color: "color-mix(in srgb, currentColor 62%, transparent)"
};

const taskTimeFormatter = new Intl.DateTimeFormat("ru", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit"
});

function matchesFilter(task: WorkspaceTaskRecord, filter: TaskCenterFilter) {
  if (filter === "all") return true;
  if (filter === "running") return task.status === "running";
  if (filter === "completed") return task.status === "completed";
  return task.status === "failed" || task.status === "interrupted" || task.status === "waiting";
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  if (minutes) return `${minutes} мин ${seconds % 60} с`;
  return `${seconds} с`;
}

function metricLabels(task: WorkspaceTaskRecord) {
  const metrics = task.metrics;
  if (!metrics) return [];
  const labels: string[] = [];
  if (metrics.durationMs !== undefined) labels.push(formatDuration(metrics.durationMs));
  const totalTokens = metrics.totalTokens ?? (
    metrics.inputTokens !== undefined || metrics.outputTokens !== undefined
      ? (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0)
      : undefined
  );
  if (totalTokens !== undefined) labels.push(`${totalTokens.toLocaleString("ru")} ток.`);
  if (metrics.filesChanged !== undefined) labels.push(`${metrics.filesChanged} файлов`);
  if (metrics.commandsRun !== undefined) labels.push(`${metrics.commandsRun} команд`);
  return labels;
}

function StatusIcon({ status }: { status: WorkspaceTaskStatus }) {
  const props = { size: 16, strokeWidth: 2, "aria-hidden": true } as const;
  if (status === "running") return <CircleDashed {...props} color="#168a75" />;
  if (status === "completed") return <CheckCircle2 {...props} color="#278153" />;
  if (status === "failed") return <CircleAlert {...props} color="#c14f49" />;
  if (status === "interrupted") return <CirclePause {...props} color="#a56b24" />;
  return <Clock3 {...props} color="#7968a8" />;
}

export function TaskCenter({
  open,
  tasks,
  variant = "drawer",
  filter,
  initialFilter = "all",
  onFilterChange,
  onClose,
  onSelectTask,
  onMarkRead,
  onMarkAllRead,
  className,
  style
}: TaskCenterProps) {
  const [internalFilter, setInternalFilter] = useState<TaskCenterFilter>(initialFilter);
  const activeFilter = filter ?? internalFilter;
  const unreadCount = tasks.reduce((count, task) => count + (task.unread ? 1 : 0), 0);
  const visibleTasks = useMemo(
    () => [...tasks]
      .filter((task) => matchesFilter(task, activeFilter))
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [activeFilter, tasks]
  );

  if (!open) return null;

  function selectFilter(nextFilter: TaskCenterFilter) {
    if (filter === undefined) setInternalFilter(nextFilter);
    onFilterChange?.(nextFilter);
  }

  const content = (
    <aside
      className={["task-center", `task-center-${variant}`, className].filter(Boolean).join(" ")}
      aria-label="Центр задач"
      aria-modal={variant === "drawer" ? true : undefined}
      role={variant === "drawer" ? "dialog" : "region"}
      style={{ ...(variant === "drawer" ? centerStyle : panelStyle), ...style }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 52, padding: "10px 12px", borderBottom: "1px solid var(--sidebar-border, #dfe3df)" }}>
        <Bell size={17} aria-hidden="true" />
        <div style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0, flex: 1 }}>
          <strong style={{ fontSize: 14 }}>Задачи</strong>
          {unreadCount > 0 && (
            <span style={{ minWidth: 19, height: 19, padding: "0 6px", borderRadius: 10, background: "#168a75", color: "#ffffff", fontSize: 11, fontWeight: 800, lineHeight: "19px", textAlign: "center" }}>
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </div>
        {unreadCount > 0 && onMarkAllRead && (
          <button type="button" style={iconButtonStyle} onClick={onMarkAllRead} aria-label="Отметить все как прочитанные" title="Отметить все как прочитанные">
            <Check size={16} aria-hidden="true" />
          </button>
        )}
        {onClose && (
          <button type="button" style={iconButtonStyle} onClick={onClose} aria-label="Закрыть центр задач" title="Закрыть">
            <X size={17} aria-hidden="true" />
          </button>
        )}
      </header>

      <div role="tablist" aria-label="Фильтр задач" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 3, margin: "10px 12px", padding: 3, border: "1px solid var(--sidebar-border, #dfe3df)", borderRadius: 8, background: "var(--sidebar-bg, #f0f2ef)" }}>
        {filterOptions.map((option) => {
          const selected = option.value === activeFilter;
          const count = tasks.filter((task) => matchesFilter(task, option.value)).length;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selected}
              style={{ minWidth: 0, height: 28, padding: "0 5px", borderRadius: 6, background: selected ? "var(--primary-bg, #202422)" : "transparent", color: selected ? "var(--primary-color, #ffffff)" : "inherit", cursor: "pointer", fontSize: 11, fontWeight: 750, whiteSpace: "nowrap" }}
              onClick={() => selectFilter(option.value)}
            >
              {option.label} {count}
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", alignContent: "start", gap: 7, minHeight: 0, overflowY: "auto", padding: "0 12px 12px" }}>
        {visibleTasks.length === 0 ? (
          <div style={{ display: "grid", minHeight: 220, placeItems: "center", alignContent: "center", gap: 9, padding: 24, textAlign: "center", ...mutedStyle }}>
            <Inbox size={25} strokeWidth={1.6} aria-hidden="true" />
            <strong style={{ fontSize: 13, color: "inherit" }}>
              {tasks.length ? "В этом фильтре задач нет" : "Задач пока нет"}
            </strong>
            <span style={{ maxWidth: 250, fontSize: 12 }}>
              {tasks.length ? "Выберите другой статус." : "Новые и завершённые задачи появятся здесь."}
            </span>
          </div>
        ) : visibleTasks.map((task) => {
          const metrics = metricLabels(task);
          const timestamp = task.completedAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt;
          return (
            <button
              key={task.id}
              type="button"
              className={`task-center-item ${task.status}${task.unread ? " unread" : ""}`}
              style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr) auto", alignItems: "start", gap: 8, width: "100%", minWidth: 0, padding: "10px 9px", border: "1px solid var(--sidebar-border, #dfe3df)", borderRadius: 8, background: task.unread ? "color-mix(in srgb, #168a75 8%, var(--chat-bg, #ffffff))" : "var(--chat-bg, #ffffff)", color: "inherit", cursor: onSelectTask || onMarkRead ? "pointer" : "default", textAlign: "left" }}
              onClick={() => {
                if (task.unread) onMarkRead?.(task.id);
                onSelectTask?.(task);
              }}
            >
              <span style={{ display: "grid", width: 22, height: 22, placeItems: "center" }}><StatusIcon status={task.status} /></span>
              <span style={{ display: "grid", minWidth: 0, gap: 4 }}>
                <strong style={{ overflow: "hidden", fontSize: 12, lineHeight: 1.35, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</strong>
                {task.summary && (
                  <span style={{ display: "-webkit-box", overflow: "hidden", fontSize: 11, lineHeight: 1.35, WebkitBoxOrient: "vertical", WebkitLineClamp: 2, ...mutedStyle }}>{task.summary}</span>
                )}
                <span style={{ display: "flex", flexWrap: "wrap", gap: "3px 8px", fontSize: 10, fontWeight: 650, ...mutedStyle }}>
                  <span>{statusLabels[task.status]}</span>
                  {metrics.map((metric) => <span key={metric}>{metric}</span>)}
                  {task.checkpoint && (
                    <span title={task.checkpoint.ref}>точка {task.checkpoint.commit.slice(0, 7)}</span>
                  )}
                </span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 5, paddingTop: 2, fontSize: 10, whiteSpace: "nowrap", ...mutedStyle }}>
                {task.unread && <span aria-label="Не прочитано" style={{ width: 6, height: 6, borderRadius: "50%", background: "#168a75" }} />}
                {taskTimeFormatter.format(new Date(timestamp))}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );

  if (variant === "panel") return content;
  return (
    <div
      className="task-center-layer"
      role="presentation"
      style={layerStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      {content}
    </div>
  );
}

export default TaskCenter;
