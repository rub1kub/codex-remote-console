import { MessageSquare, X } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";

import { workspaceChatKey, type WorkspaceChatTab } from "./workspaceState";

export type WorkspaceTabsProps = {
  tabs: readonly WorkspaceChatTab[];
  activeChatKey: string | null;
  onActivate: (tab: WorkspaceChatTab) => void;
  onClose: (tab: WorkspaceChatTab) => void;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
};

const tabListStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 2,
  minWidth: 0,
  minHeight: 34,
  overflowX: "auto",
  overflowY: "hidden",
  padding: "3px 5px 0",
  borderBottom: "1px solid var(--sidebar-border, #dfe3df)",
  background: "var(--sidebar-bg, #f0f2ef)",
  scrollbarWidth: "thin"
};

const tabStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 26px",
  flex: "0 1 220px",
  minWidth: 116,
  maxWidth: 240,
  height: 31,
  overflow: "hidden",
  border: "1px solid transparent",
  borderBottom: 0,
  borderRadius: "7px 7px 0 0",
  color: "inherit"
};

const activeTabStyle: CSSProperties = {
  borderColor: "var(--sidebar-border, #dfe3df)",
  background: "var(--chat-bg, #ffffff)"
};

const tabButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
  padding: "0 4px 0 9px",
  border: 0,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left"
};

const titleStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: "30px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const closeButtonStyle: CSSProperties = {
  display: "grid",
  width: 24,
  height: 24,
  alignSelf: "center",
  placeItems: "center",
  padding: 0,
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  opacity: 0.62
};

export function WorkspaceTabs({
  tabs,
  activeChatKey,
  onActivate,
  onClose,
  ariaLabel = "Открытые чаты",
  className,
  style
}: WorkspaceTabsProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") nextIndex = index === 0 ? tabs.length - 1 : index - 1;
    if (event.key === "ArrowRight") nextIndex = index === tabs.length - 1 ? 0 : index + 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined || !tabs[nextIndex]) return;
    event.preventDefault();
    onActivate(tabs[nextIndex]);
    event.currentTarget.parentElement?.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]
      ?.focus();
  }

  if (!tabs.length) return null;

  return (
    <div
      className={["workspace-tabs", className].filter(Boolean).join(" ")}
      role="tablist"
      aria-label={ariaLabel}
      style={{ ...tabListStyle, ...style }}
    >
      {tabs.map((tab, index) => {
        const key = workspaceChatKey(tab.profileId, tab.threadId);
        const active = key === activeChatKey;
        const tooltip = tab.path ? `${tab.title}\n${tab.path}` : tab.title;
        return (
          <div
            key={key}
            className={`workspace-tab${active ? " active" : ""}`}
            style={active ? { ...tabStyle, ...activeTabStyle } : tabStyle}
          >
            <button
              type="button"
              className="workspace-tab-main"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tooltip}
              style={tabButtonStyle}
              onClick={() => onActivate(tab)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <MessageSquare size={14} strokeWidth={1.9} aria-hidden="true" />
              <span style={titleStyle}>{tab.title}</span>
            </button>
            <button
              type="button"
              className="workspace-tab-close"
              aria-label={`Закрыть чат «${tab.title}»`}
              title="Закрыть чат"
              style={closeButtonStyle}
              onClick={() => onClose(tab)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default WorkspaceTabs;
