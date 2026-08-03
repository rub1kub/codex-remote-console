# Changelog

## 1.5.2 - 2026-07-27

- Rebuilt the window as a native macOS-style shell: the title strip is gone — the sidebar material runs the full window height with traffic lights floating над ним, the chat header became a transparent draggable toolbar with a settings button, and hard border lines were replaced by scroll-edge gradients.
- Removed the sidebar footer: Tasks is now a source-list row with a count badge; Settings lives in the toolbar.
- Turned the composer into a floating capsule (rounded glass, pill controls, circular send) and the chat into a clean feed: iMessage-style user bubbles without author/timestamp rows, agent steps as a thin progress thread instead of a boxed widget.
- Restyled the command palette as Spotlight: larger centered capsule with a 17px input.
- Rebuilt Settings in the System Settings pattern: section navigation on the left, one pane at a time on the right; the active theme segment is neutral instead of tinted.
- Fixed a box-in-box seam on the composer's disabled ("connect first") state: a leftover dark-mode rule was painting a solid rectangle behind the placeholder inside the rounded capsule.
- Rounded the standalone settings toggle rows (Appearance, Behavior, Codex tabs), which previously rendered as flat-edged slabs with no radius.
- Fixed the assistant message avatar rendering green instead of the intended blue accent in dark mode (a higher-specificity legacy rule was winning over the theme token).
- Swept ~15 more legacy hardcoded greens that were bleeding "connection status" color into unrelated interactive/decorative elements (About links, pinned-thread icon, file-tree hover/active, diff file references, quick-command and task-file hovers, folder badges/hover, bootstrap-card icon, loading spinner, queued-send button, timeline icon) — green is now reserved for genuine connection/success state, everything else uses the blue accent or a neutral token.
- Added a right-click context menu on project rows (Edit / Delete), matching the existing thread context menu — deleting a project previously required discovering the hidden `/permissions` slash command.
- Project deletion now goes through a confirmation dialog naming the project, from both the new context menu and the existing profile editor; it previously deleted instantly with no confirmation.
- Fixed multi-server navigation in the sidebar: server groups now stack vertically and every project row uses the full available width instead of collapsing into unreadable horizontal columns.

- Fixed local projects on Windows: POSIX project tooling now runs through Git Bash (with a clear setup message when it is missing) instead of failing silently under cmd.exe.
- Fixed launching `codex app-server` for local Windows projects by resolving the npm `codex.cmd` shim and spawning it through cmd.exe.
- Fixed the Windows/Linux window chrome: title-bar overlay now follows the app theme (light/dark), the titlebar layout no longer reserves macOS traffic-light space, and the sidebar toggle no longer collides with the window controls.
- Fixed the "user message color" preference, which previously had no visual effect.
- Made `npm start` cross-platform (no POSIX-only env syntax).
- Refreshed the visual system in an Apple-style direction: system blue accent, iMessage-style user bubbles, neutral macOS light/dark palettes, softer radii, and blue ambient backdrops.
- Applied a design-review polish pass: root font smoothing, a 10px floor for micro-labels with tracked uppercase captions, tabular numerals on live metrics, standard 0.96 press scale, an instant (non-animated) command palette, blue file references/chips so green is reserved for connection status, higher-contrast tertiary text, concentric nested radii, light-catching top edges on glass surfaces, and accent-colored caret/selection.
- Moved the sidebar toggle to the left edge of the title bar, next to the panel it controls.
- Made the sidebar fluid: drag its edge with 1:1 tracking, rubber-banding past the limits, momentum projection on release, and an interruptible critically-damped spring (also used by the toggle button); custom widths persist.
- Flattened menu rows and inputs inside glass containers (popover options, search, composer) that previously rendered as boxes-within-boxes, and removed the remaining green-tinted legacy palette from the base stylesheet.
- Fixed the system theme: "system" now resolves to a concrete light/dark class (and follows OS changes live), so every themed rule applies — this cures invisible command-palette titles, a white search input in dark mode, and surfaces with mixed light/dark borders.
- Readability pass from an adversarial design review: readable user-bubble blue (WCAG AA), quiet timestamps, tokenized legacy hardcoded colors, flat command-palette rows without icon tiles and without a focus ring on the dialog itself, a scrollable un-boxed model list, a single-surface composer with concentric radii, gray disabled primary buttons, plain-text status rows in Settings, neutral segmented controls, one 960px content column, calmer static ambient light, no clipped text in the collapsed rail, and no duplicate user avatar.

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
