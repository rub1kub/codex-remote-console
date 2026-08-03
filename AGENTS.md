# Codex Remote: instructions for agents

This file is the mandatory entry point for work in this repository.

## Read first

1. `docs/project-knowledge-base.md` is the canonical description of this
   application: architecture, contracts, persistence, security, tests, release
   process, and known limitations.
2. `README.ru.md` and `README.md` describe the user-visible product.
3. `docs/codex-cli-knowledge-base.md` describes the upstream Codex CLI and
   app-server that this application controls.
4. `docs/research.md` records the original product and protocol research.

If documentation disagrees with executable code, treat the code and tests as
the current truth and update the knowledge base in the same change.

## Product invariant

Codex Remote is an Electron desktop client for running and resuming Codex CLI
sessions on local or remote projects. It is not a terminal wrapper. The primary
runtime path is:

`React -> local Express/WebSocket backend -> SSH or local process -> codex app-server over JSONL stdio`.

## Non-negotiable constraints

- Keep the backend bound to loopback and preserve Host/Origin validation.
- Never log, export, commit, or include SSH passwords, OpenAI credentials,
  ChatGPT cookies, tokens, or private server details in fixtures or docs.
- Keep Electron `contextIsolation: true`, `nodeIntegration: false`, and
  `sandbox: true`.
- Preserve project-path confinement for file, diff, and Git APIs. Test absolute
  paths, `..`, and symlink escapes when changing these surfaces.
- Preserve JSON-RPC request/response correlation and the distinction between
  app-server notifications and server-initiated approval requests.
- A historical thread must be resumed before a new turn is started in it.
- Complete a task only for the matching terminal turn event. Do not infer
  completion from an arbitrary assistant message.
- Keep `server/types.ts` and `src/types.ts` aligned for shared contracts.
- Do not edit generated `dist/`, `build/server/`, or `release/` output by hand.
- Avoid unrelated changes in the existing dirty worktree.

## Source ownership

- `electron/`: native application lifecycle, windows, IPC, platform chrome.
- `server/index.ts`: loopback HTTP and WebSocket boundary.
- `server/codexBridge.ts`: Codex app-server JSON-RPC bridge.
- `server/remoteExec.ts`: local/SSH execution, CLI diagnostics, project reads.
- `server/projectTools.ts`: guarded Git/runtime/AGENTS.md operations.
- `server/profiles.ts`: profiles, preferences, thread metadata.
- `server/secrets.ts`: Electron safeStorage-backed password storage.
- `src/App.tsx`: main product orchestration and chat workflow.
- `src/ProjectWorkbench.tsx`: Git, runtime, logs, and project instructions.
- `src/TaskCenter.tsx`, `src/WorkspaceTabs.tsx`: workspace task/tab UI.
- `src/taskProtocol.ts`, `src/messageHistory.ts`, `src/modelCatalog.ts`,
  `src/workspaceState.ts`: independently testable domain logic.
- `src/styles.css`: legacy/base layout; `src/redesign.css`: final visual-system
  overrides, imported after the base stylesheet.

## Minimum verification

Choose checks by the changed surface:

- Shared TypeScript or API contracts: `npm run typecheck`.
- Turn lifecycle: `npm run test:task-protocol`.
- Restored chat history: `npm run test:message-history`.
- Paginated Codex history transport: `npm run test:codex-history`.
- Model catalog: `npm run test:model-catalog`.
- File/shell confinement: `npm run test:shell`.
- Git/checkpoint/AGENTS.md tools: `npm run test:project-tools`.
- Layout, dialogs, themes, composer: `npm run test:ui`.
- Real configured SSH project: `npm run smoke:ssh`.
- Packaging/version/release assets: `npm run qa:release`.

Run `npm run build` before packaging. A feature that depends on SSH, Codex
app-server, files, or remote shell behavior is not fully verified by mocked UI
tests alone.

## Version and release invariant

The release version must match in:

- `package.json`
- root entries in `package-lock.json`
- `src/App.tsx` (`appVersion`)
- `server/codexBridge.ts` (`clientInfo.version`)
- `CHANGELOG.md`
- release filenames checked by `scripts/release-qa.mjs`

Builds are unsigned unless signing/notarization is configured externally.

## Before finishing

- Update `docs/project-knowledge-base.md` when architecture, routes, messages,
  persisted data, security boundaries, commands, or release behavior changes.
- Run the smallest relevant automated checks and state exactly what was not run.
- For remote features, distinguish local automated coverage from a real-server
  smoke test.
