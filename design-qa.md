# Design QA

## Scope

- Product: Codex Remote desktop application
- Redesign direction: focused command studio with an ambient workspace
- Source visual truth: `/var/folders/ry/szm9whdj3y1f41mybqx4sclw0000gn/T/codex-clipboard-b5b1f214-8965-48ad-b4ad-a82b9ca25995.png`
- Tested viewport: 1133 x 768
- Tested themes: light, dark, system
- Tested state: connected to the real `TON Tracker` project at `/root/TON_ACTIVITY_BOT`

## Evidence

- Reference and implementation comparison: `.codex/redesign/comparison-dark.png`
- Final dark workspace: `.codex/redesign/current-dark-final.png`
- Final light workspace: `.codex/redesign/current-light.png`
- Responsive task inspector: `.codex/redesign/current-inspector.png`
- Final reduced-density workspace: `.codex/redesign/declutter-light-final.jpg`
- Full-view source/implementation comparison: `.codex/redesign/declutter-comparison-final.png`

## Comparison

The final comparison uses the supplied overloaded dark workspace as the source and the light implementation at the same 1133 x 768 crop. Theme differs intentionally so that the light-theme contrast fix is visible; information hierarchy and density are comparable. The implementation keeps a compact desktop sidebar, quiet project status, focused chat canvas, integrated work progress, a stable composer, and restrained animated purple ambient light.

Focused checks were required for the user-message bubble, sidebar footer, and composer because the full comparison makes their text and icon contrast too small to judge. The accepted light capture shows a dark, readable user bubble; the footer uses labelled tooltips and accessibility labels; the composer has only one persistent contour.

## Findings

- No actionable P0, P1, or P2 findings remain.
- P3: footer tools are intentionally icon-only to keep the workspace quiet. Their visible labels appear on hover and their accessibility labels remain available.

### Fidelity surfaces

- Typography: assistant content is 13 px with a relaxed 1.68 line height; metadata uses a smaller neutral weight. Long thread titles truncate rather than push controls out of frame.
- Spacing and layout rhythm: sidebar is 264 px, responses are not surrounded by full cards, and the composer uses a single surface instead of nested frames.
- Colors and tokens: connection is a quiet dot, purple is reserved for active work and selection, and user messages use a fixed dark foreground/background pair in both themes.
- Image quality: ambient light uses the existing optimized WebP raster assets with reduced opacity in an active chat.
- Copy and content: primary controls are kept as project, chats, command menu, task center, events, settings, and message input; rare actions are discoverable through the command search.

## Iterations

1. First implementation exposed an opaque portal background over settings and task panels. Fixed by making the command-studio portal transparent and leaving dimming to the overlay component.
2. The task inspector inherited desktop grid coordinates below 1180 px. Fixed by resetting its grid row and column in the responsive breakpoint.
3. Dark-theme workbench feedback and selected task filters lacked semantic contrast. Fixed with theme-token success, error, and selected states.
4. Ambient PNG assets were replaced with optimized WebP files, reducing each asset to roughly 11-12 KB without changing the visual direction.
5. [P1] The workspace showed too many permanent controls, repeated connection/task states, and card borders. Fixed by removing the header task switcher and text connection chip, moving task details to the result, converting the footer to three icon tools, hiding the archive control until search interaction, and flattening assistant responses, file summaries, and task status.
6. [P1] The initial light-theme user bubble had insufficient contrast. Fixed by using an explicit dark bubble with white foreground text. Post-fix evidence: `.codex/redesign/declutter-light-final.jpg`.
7. [P2] The command palette listed every implementation action at once. Fixed by showing 12 frequent actions by default and keeping rare operations searchable via Cmd+K.
8. [P1] Command palette and settings did not close on an overlay click; command palette disappeared without an exit animation. Fixed with shared close handlers, backdrop pointer handling, and 180-260 ms exit transitions.
9. [P2] Sidebar footer controls had inconsistent widths and notification counts drifted away from their triggering button. Fixed with fixed 36 px icon buttons and an anchored notification badge.
10. [P2] Active project and chat used full outline treatments, and the active chat displayed a pin affordance that suggested it was pinned. Fixed with fill-only selection states and by hiding the pin action for the active chat.
11. [P1] Disabled settings actions had insufficient text contrast in the light theme. Fixed with semantic disabled colors. Added persistent color controls for accent, connection, and user-message colors with safe hex validation in the preferences store.
12. [P2] Composer placeholder sat too high in its input surface. Fixed by adjusting line height and vertical padding.

## Functional QA

- Electron application reloaded from the final source and remained running.
- Real SSH project connected successfully and server history loaded.
- A live safe task executed `sleep 8 && echo CODEX_REMOTE_REDESIGN_OK` without modifying files.
- The server returned `CODEX_REMOTE_REDESIGN_DONE`.
- During the task the UI showed a single user message, active-task state, elapsed time, stop control, command progress, completion, and result summary.
- Settings, task center, project workbench, and responsive task inspector were opened and visually checked.
- After the density pass, the Electron application was rebuilt, reconnected to the live project, opened the real thread history, opened the compact command palette, and checked the final light workspace.
- The current Electron build was checked for command-palette and settings overlay close behavior, footer sizing, active-chat pin removal, color-picker visibility, and light-theme settings contrast. Final screenshot: `.codex/redesign/ui-fixes-final.jpg`.

## Automated Checks

- `npm run build` - passed
- `npm run test:task-protocol` - passed
- `npm run test:message-history` - passed
- `npm run test:project-tools` - passed
- `npm run test:shell` - passed
- `npm run qa:release` - passed for version 1.4.0
- `git diff --check` - passed

## Remaining Risk

- The remote test server does not have `git` installed, so the project workbench correctly reports that Git operations are unavailable there. The error state was verified; live stage/commit/push was not possible on that host.

final result: passed
