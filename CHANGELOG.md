# Changelog

## 1.6.0 - 2026-08-04

- Added a Skills picker: typing `@skill:` in the composer now searches Codex's real skill catalog (via the native `skills/list` app-server method) and lets you attach a skill to the turn, instead of only being able to ask the model in plain text what skills exist. The `/skills` slash command now opens this picker instead of sending a canned prompt.

## 1.5.8 - 2026-08-04

- The collapsed "steps" toggle above the final answer now reads "Обработка заняла Xм Yс" (live-ticking "Обрабатываю… Xс" while the task is still running), matching ChatGPT's "Thought for..." pattern, for the most recently run turn. Older turns loaded from history still show "Ход работы" with a step count, since per-turn timing isn't carried through the message pipeline for reloaded threads.

## 1.5.7 - 2026-08-04

- Added markdown rendering for chat messages: `#`-`######` headings, `-`/`*` and `1.` lists, `> ` blockquotes, and `**bold**`/`*italic*`/`_italic_` now render as real elements instead of showing the raw markdown characters (e.g. a literal `## Текущее состояние` line). Extends the existing safe renderer — every branch still returns React elements, never raw HTML, so this stays a read-only formatting layer, not a new injection surface.
- Extracted the message-rendering functions out of `App.tsx` into `src/messageMarkdown.tsx` and added `scripts/test-markdown.ts`, a real regression test (`react-dom/server` + `renderToStaticMarkup`, no browser needed) covering headings, lists, blockquotes, bold/italic, code spans, file references, and the `snake_case` vs `_italic_` boundary check.

## 1.5.6 - 2026-08-04

- Fixed a stray solid blue bar poking out above the composer's rounded corners while a task is running: two CSS layers each declared half of the same `::before` pulse-ring element (one an old horizontal progress bar, one the current outline ring), and their unrelated properties (a fixed `height`, a solid `background`) leaked through and merged into a broken hybrid shape instead of the intended full ring around the capsule.
- Added a clearly-labeled way to skip the send queue: while a task is running, the "В очереди N" banner now has an "Прервать и отправить" button that stops the current task and immediately runs the next queued message, instead of only being reachable by separately guessing that the stop button drains the queue.
- Hid the token counter by default (in both the task-status bar and the task summary card in the chat feed); the existing "Показывать токены задачи" toggle in Settings → Поведение still turns it back on.
- Added account usage visibility: Settings → Сервер now shows the current rate-limit window's used percentage, reset time, and plan (via the native `account/rateLimits/read` app-server method), fetched automatically after connecting. Best-effort — silently absent on older CLI builds that don't support the method.

## 1.5.5 - 2026-08-04

- Fixed opening a brand-new chat (or any thread with no turns yet): the app-server rejects `thread/turns/list` on an unmaterialized thread with "is not materialized yet; thread/turns/list is unavailable before first user message", and that specific message was not recognized as a normal empty-history case, so it surfaced as a hard error and blocked the chat from opening. It's now treated as "zero turns" and the chat opens normally.
- Fixed a double focus ring on the composer, search box, and command palette input: a generic keyboard-focus outline was stacking on top of each field's own blue focus glow (and, on plain settings inputs, on top of a leftover green ring from before the accent-color cleanup). Text fields now show exactly one blue ring.

## 1.5.4 - 2026-08-03

- Fixed the 1.5.3 history regression on Codex servers where `thread/turns/list` is available but `thread/items/list` still returns `is not supported yet`: chat history now opens from one bounded page of the 20 newest compact summary turns, so it neither calls the unsupported endpoint nor waits for the entire archive before rendering.
- Extended the compatibility fallback to recognize the exact `not supported yet` response used by older app-server builds.
- Added a full-history fallback for app-server builds that return an empty summary page or only non-displayable summary items; the bridge retries the previously compatible `thread/read includeTurns: true` path with a dedicated 180-second timeout instead of treating an empty-looking response as loaded history.
- Empty server-side threads now show an explicit “history is empty” state after opening instead of the generic prompt to open a chat.

## 1.5.3 - 2026-08-03

- Fixed large remote chats failing to open after 45 seconds: history now loads through bounded `thread/turns/list` and `thread/items/list` pages; older Codex versions fall back to the monolithic read with a dedicated 180-second timeout.
- Made selected projects and chats visually neutral, without a blue fill, blue folder icon, or left accent edge that could be mistaken for connection state.
- Made the connecting spinner blue; green remains reserved for the connected status dot and successful outcomes.

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
