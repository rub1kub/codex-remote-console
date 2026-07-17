# Changelog

## 1.5.1 - 2026-07-17

- Removed automatic focus and the purple focus ring from the command palette input while preserving keyboard navigation through a neutral dialog focus target.
- Rebuilt Settings scrolling so its header remains stable, content never slides underneath it, and every open starts at the top.
- Made theme token changes atomic to eliminate staggered light/dark color transitions.
- Aligned the sidebar footer with the composer and removed the purple outline from the active project.
- Added UI regressions for command focus, overlay close, Settings geometry and scroll reset, atomic theme changes, bottom-bar alignment, and active-project styling.

## 1.5.0 - 2026-07-17

- Rebuilt the desktop visual system around a calmer macOS-style shell with unified light and dark themes, compact project navigation, a refined chat header, and a focused composer.
- Added restrained animated ambient light for empty and active states, consistent motion for popovers and dialogs, and accessibility fallbacks for reduced motion and transparency.
- Reworked conversation turns so progress, final answers, and changed files form one readable vertical flow without collapsing long messages.
- Unified settings and the task center as centered workspace dialogs, simplified the sidebar footer, and replaced the ambiguous header menu with a command palette shortcut.
- Extended UI regression coverage for model popover geometry, overlay behavior, composer alignment, dark mode, and long-message layout.

## 1.4.0 - 2026-07-09

- Reworked the workspace into a compact desktop layout with collapsible navigation, chat tabs, per-chat drafts, grouped history, task states, and a persistent task center.
- Added independent Electron project windows for parallel remote Codex tasks.
- Added the Project workbench with Git operations, branches, processes, logs, services, and guarded root `AGENTS.md` editing.
- Added non-destructive Git checkpoints before tasks.
- Added profile export/import without passwords, improved approval handling, reconnect state, task summaries, dark theme, and live activity indicators.
- Hardened local HTTP/WebSocket access, profile writes, remote path confinement, Git path handling, and task completion correlation.
