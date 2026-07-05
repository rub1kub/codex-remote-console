# Codex CLI knowledge base

Дата среза: 2026-07-05.

Источники:

- Официальный Codex manual, получен через `openai-docs` skill: `/var/folders/ry/szm9whdj3y1f41mybqx4sclw0000gn/T/openai-docs-cache/codex-manual.md`
- Официальные docs: [developers.openai.com/codex](https://developers.openai.com/codex), [CLI reference](https://developers.openai.com/codex/cli/reference), [App Server](https://developers.openai.com/codex/app-server)
- Исходники: [openai/codex](https://github.com/openai/codex), commit `be33f80bc65159c094ecd06bf155afa3061ce23d` от `2026-07-05`
- Локальный клон для аудита: `/tmp/openai-codex-src`

## 1. Короткая модель

Codex CLI - это локальный coding agent поверх Rust runtime. Пользовательские поверхности разные, но ядро общее:

- interactive CLI/TUI: `codex`
- headless CLI: `codex exec`
- IDE/GUI/custom clients: `codex app-server`
- Codex как MCP server: `codex mcp-server`
- process/filesystem executor для удаленных сред: `codex exec-server`

Главные сущности:

- `Thread` - долговременная ветка диалога/работы. Раньше называлась conversation/session в части кода.
- `Turn` - один пользовательский запрос или шаг агента внутри thread.
- `Item` - сообщение, reasoning, tool call, file change, command execution, MCP call и т.д.
- `Rollout` - JSONL-транскрипт thread, локальный durable replay format.
- `CODEX_HOME` - корень локального состояния, по умолчанию `~/.codex`.

Высокоуровневый поток:

1. CLI wrapper запускает native Rust binary.
2. CLI/TUI/exec/app-server создает или resume-ит `Thread`.
3. `ThreadManager` держит активные `CodexThread` в памяти.
4. `CodexThread` прокидывает операции в `Session`.
5. `Session` сериализует активный turn, config, auth, permissions, MCP/plugins/skills и events.
6. `RegularTask` вызывает `run_turn`.
7. `run_turn` строит prompt из history, pending input, AGENTS/skills/plugins/apps/MCP injections, hooks и world-state.
8. `ModelClientSession` отправляет stream request в Responses API.
9. Ответ модели может быть assistant text, reasoning или tool calls.
10. Tool calls идут через `ToolOrchestrator`: approval/hooks/guardian -> sandbox selection -> execution -> output возвращается модели следующим sampling request.
11. Финальные items пишутся в thread store и rollout JSONL, события стримятся клиенту.

## 2. Репозиторий и модули

Ключевые директории:

- `codex-cli/` - npm package wrapper `@openai/codex`.
- `codex-rs/cli/` - основной Rust CLI entrypoint и subcommands.
- `codex-rs/tui/` - interactive terminal UI.
- `codex-rs/exec/` - `codex exec` headless mode.
- `codex-rs/app-server/` - JSON-RPC app-server для GUI/IDE/custom clients.
- `codex-rs/app-server-protocol/` - типы app-server protocol, schema/TS generation.
- `codex-rs/app-server-transport/` - stdio/WebSocket/Unix socket transports.
- `codex-rs/exec-server/` - JSON-RPC process/filesystem execution server.
- `codex-rs/core/` - agent runtime: session, turns, model client, tools, sandboxing, MCP, skills, rollout.
- `codex-rs/api/` - low-level OpenAI/ChatGPT API clients.
- `codex-rs/model-provider-info/` - providers, base URLs, wire API capability.
- `codex-rs/thread-store/` - persistence boundary for threads.
- `codex-rs/rollout/` - JSONL rollout persistence and SQLite metadata repair/backfill.

## 3. Установка и обновление

Официальные способы установки:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
npm install -g @openai/codex
brew install --cask codex
```

Windows:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

NPM wrapper:

- entrypoint: `codex-cli/bin/codex.js`
- выбирает platform package и native binary из `vendor/<targetTriple>/bin/codex`
- выставляет `CODEX_MANAGED_BY_NPM=1` или `CODEX_MANAGED_BY_BUN=1`
- выставляет `CODEX_MANAGED_PACKAGE_ROOT`
- прокидывает сигналы `SIGINT`, `SIGTERM`, `SIGHUP`

Platform packages:

- `@openai/codex-linux-x64`
- `@openai/codex-linux-arm64`
- `@openai/codex-darwin-x64`
- `@openai/codex-darwin-arm64`
- `@openai/codex-win32-x64`
- `@openai/codex-win32-arm64`

Self-update:

`codex update` выбирает действие по install context:

- npm: `npm install -g @openai/codex`
- bun: `bun install -g @openai/codex`
- Homebrew: `brew upgrade --cask codex`
- standalone Unix: `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh`
- standalone Windows: `install.ps1` с `CODEX_NON_INTERACTIVE=1`

Проверка версии:

- cache: `$CODEX_HOME/version.json`
- refresh примерно после 20 часов
- npm/bun сверяют GitHub latest release и npm packument
- standalone/other берут latest release из GitHub
- release tags имеют формат `rust-vX.Y.Z`

Standalone installer:

- `CODEX_RELEASE` - latest или конкретная версия
- `CODEX_NON_INTERACTIVE`
- `CODEX_INSTALL_DIR`, default `$HOME/.local/bin`
- `CODEX_HOME`, default `$HOME/.codex`
- release root: `$CODEX_HOME/packages/standalone`
- скачивает release assets, проверяет SHA-256, обновляет symlink/current path

## 4. Auth и серверные логины

Поддерживаемые auth modes:

- ChatGPT sign-in - основной путь для CLI/IDE/app/cloud.
- API key - рекомендуется для CI/headless automation.
- Access token - trusted automation через `CODEX_ACCESS_TOKEN`.

Переменные:

- `OPENAI_API_KEY`
- `CODEX_API_KEY`
- `CODEX_ACCESS_TOKEN`

Локальное хранение:

- file store: `$CODEX_HOME/auth.json`
- keyring store: OS credential store
- режим: `cli_auth_credentials_store = "file" | "keyring" | "auto"`

Headless/server варианты:

```bash
codex login --device-auth
printenv CODEX_ACCESS_TOKEN | codex login --with-access-token
```

Можно скопировать `~/.codex/auth.json` на headless host, но это секрет. Не коммитить, не логировать, не прикладывать к tickets.

Managed restrictions:

- `forced_login_method = "chatgpt"` или `"api"`
- `forced_chatgpt_workspace_id`

Custom CA:

- `CODEX_CA_CERTIFICATE`
- fallback: `SSL_CERT_FILE`

## 5. Config и state

Config precedence, сверху вниз:

1. CLI flags и `--config`/`-c`
2. project `.codex/config.toml` от project root к cwd, только trusted projects
3. profile `$CODEX_HOME/<profile>.config.toml`
4. user `$CODEX_HOME/config.toml`
5. system `/etc/codex/config.toml`
6. built-in defaults

Основные state paths:

- `$CODEX_HOME/config.toml`
- `$CODEX_HOME/auth.json`
- `$CODEX_HOME/log/`
- `$CODEX_HOME/history.jsonl`
- `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread_id>.jsonl`
- `$CODEX_HOME/archived_sessions/...`
- `$CODEX_HOME/version.json`
- `$CODEX_HOME/plugins/`
- `$CODEX_HOME/packages/standalone/`

SQLite state:

- default: `$CODEX_HOME`
- override: `CODEX_SQLITE_HOME`
- config override: `sqlite_home`

Thread persistence:

- JSONL rollout is canonical local replay format.
- SQLite state DB is queryable metadata/index layer.
- If SQLite is missing/unavailable, Codex falls back to filesystem JSONL scans.
- Startup can backfill/repair SQLite rows from rollout files.

Prompt history:

- global prompt history: `$CODEX_HOME/history.jsonl`
- schema: `{"session_id":"<uuid>","ts":<unix_seconds>,"text":"<message>"}`
- writes use append/locking to avoid interleaving.

## 6. Sandbox, approvals, network

Default local behavior:

- trusted version-controlled workdir: usually `workspace-write` plus `on-request`
- untrusted/non-versioned dirs: more restrictive
- network disabled by default for agent commands

Common modes:

- `read-only` - can inspect, cannot write.
- `workspace-write` - can read and write workspace, network off unless enabled.
- `danger-full-access` - no filesystem sandbox boundary.

Approval policy:

- `never` - no approval prompts.
- `on-request` - ask when escalation is needed.
- `unless-trusted` - ask broadly.
- granular variants exist in newer configs.

Tool execution path:

1. Tool decides approval requirement.
2. `ToolOrchestrator` checks cached approvals and hooks.
3. Optional guardian/auto-review or user approval.
4. Sandbox selected by filesystem/network policy and platform.
5. Command/tool runs.
6. On sandbox denial, may retry with approved escalation if policy allows.

Protected writable roots:

- `.git`
- resolved gitdir
- `.agents`
- `.codex`

Platform sandboxing:

- macOS: Seatbelt.
- Linux/WSL2: bubblewrap or bundled helper, requires user namespace support.
- Windows: native sandbox/elevated setup flow.

Managed network proxy:

- applies only when network is enabled by sandbox/profile.
- can allow/deny domains, block local/private networks by default, protect DNS rebinding.

## 7. OpenAI/ChatGPT API layer

Default provider endpoints:

- API key/OpenAI platform: `https://api.openai.com/v1`
- ChatGPT/ChatGPTAuthTokens/AgentIdentity/PAT: `https://chatgpt.com/backend-api/codex`

Wire API:

- current primary wire API: Responses API
- Chat Completions path is deprecated/removed for current Codex runtime

Main upstream routes used by runtime:

- `POST /responses` - streaming sampling
- WebSocket `/responses` - Responses-over-WebSocket
- `POST /responses/compact` - compaction
- `GET /models` - model catalog
- `POST /images/generations`
- `POST /images/edits`
- `POST /memories/trace_summarize`
- `POST /realtime/calls`
- `POST /alpha/search`

Important headers:

- `x-client-request-id`
- `session-id`
- `thread-id`
- `x-codex-installation-id`
- `x-codex-turn-state` - sticky routing token for one turn
- `x-codex-turn-metadata`
- `x-codex-parent-thread-id`
- `x-codex-window-id`
- `x-openai-subagent`
- `OpenAI-Organization` from `OPENAI_ORGANIZATION`
- `OpenAI-Project` from `OPENAI_PROJECT`
- WebSocket beta: `OpenAI-Beta: responses_websockets=2026-02-06`

`ModelClient`:

- lives for session lifetime.
- stores provider/auth/transport fallback state.
- creates fresh `ModelClientSession` per turn.

`ModelClientSession`:

- caches WebSocket connection lazily.
- stores per-turn `x-codex-turn-state`.
- can reuse incremental WebSocket requests only if non-input request properties match.
- must not be reused across turns.

Retry/fallback:

- retry stream errors up to provider `stream_max_retries`.
- after max retries, can fallback from WebSocket to HTTPS.
- emits warning to clients on fallback.

## 8. CLI entrypoints

Top-level subcommands observed in current source:

- `exec`
- `review`
- `login`
- `logout`
- `mcp`
- `plugin`
- `mcp-server`
- `app-server`
- `remote-control`
- `app`
- `completion`
- `update`
- `doctor`
- `sandbox`
- `debug`
- `apply`
- `resume`
- `archive`
- `delete`
- `unarchive`
- `fork`
- `cloud`
- `features`
- hidden/internal: `execpolicy`, `responses-api-proxy`, `stdio-to-uds`, `exec-server`

No subcommand запускает interactive TUI.

`codex exec`:

- headless non-interactive mode.
- может output обычный human text или JSONL через `--json`.
- запускает in-process app-server client.
- создает или resume-ит thread через `thread/start`/`thread/resume`.
- запускает turn через `turn/start`.
- слушает server notifications до `turn/completed`.
- `Ctrl-C` отправляет `turn/interrupt`.
- по умолчанию ставит approval policy `never`, но пересобирает config при `AutoReview`, если это нужно.
- `--ephemeral` не пишет session files.
- `--ignore-user-config` не грузит `$CODEX_HOME/config.toml`, auth всё равно из `CODEX_HOME`.
- `--ignore-rules` отключает user/project execpolicy rules.

## 9. App Server

Назначение:

- глубокая интеграция IDE/GUI/custom clients;
- auth, history, approvals, streamed events, files/process helpers;
- protocol v2, JSON-RPC 2.0 без поля `"jsonrpc":"2.0"` на wire.

Команды:

```bash
codex app-server
codex app-server --listen stdio://
codex app-server --listen ws://127.0.0.1:4500
codex app-server --listen unix://
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

Transports:

- `stdio://` - default, newline-delimited JSON.
- `ws://IP:PORT` - experimental TCP WebSocket, one JSON-RPC per text frame.
- `unix://` или `unix://PATH` - WebSocket over Unix socket.
- `off` - disables local transport.

HTTP routes в WebSocket listener:

- `GET /readyz` - `200 OK`, когда listener принимает connections.
- `GET /healthz` - `200 OK`, если нет `Origin` header.
- request с `Origin` header получает `403`.
- остальные requests идут в WebSocket upgrade fallback.

WebSocket auth:

- `--ws-auth capability-token`
- `--ws-auth signed-bearer-token`
- `Authorization: Bearer ...` during WebSocket handshake
- non-local listener без auth должен считаться небезопасным

Backpressure:

- bounded queues.
- при заполненном request ingress: JSON-RPC error `-32001`, message `"Server overloaded; retry later."`

Lifecycle:

1. Client sends `initialize` with `clientInfo`.
2. Server responds with user agent, `codexHome`, platform family/os.
3. Client sends `initialized`.
4. Client calls `thread/start`, `thread/resume`, or `thread/fork`.
5. Client calls `turn/start`.
6. Server streams notifications.
7. Turn ends via `turn/completed` or error/interruption.

Важно: app-server "routes" - это JSON-RPC `method`, а не REST endpoints.

### App-server request methods

Thread lifecycle/history:

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/archive`
- `thread/delete`
- `thread/unsubscribe`
- `thread/increment_elicitation`
- `thread/decrement_elicitation`
- `thread/name/set`
- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`
- `thread/metadata/update`
- `thread/settings/update`
- `thread/memoryMode/set`
- `memory/reset`
- `thread/unarchive`
- `thread/compact/start`
- `thread/shellCommand`
- `thread/approveGuardianDeniedAction`
- `thread/backgroundTerminals/clean`
- `thread/backgroundTerminals/list`
- `thread/backgroundTerminals/terminate`
- `thread/rollback`
- `thread/list`
- `thread/search`
- `thread/loaded/list`
- `thread/read`
- `thread/turns/list`
- `thread/items/list`
- `thread/inject_items`

Skills/hooks/plugins/apps:

- `skills/list`
- `skills/extraRoots/set`
- `hooks/list`
- `marketplace/add`
- `marketplace/remove`
- `marketplace/upgrade`
- `plugin/list`
- `plugin/installed`
- `plugin/read`
- `plugin/skill/read`
- `plugin/share/save`
- `plugin/share/updateTargets`
- `plugin/share/list`
- `plugin/share/checkout`
- `plugin/share/delete`
- `app/list`
- `skills/config/write`
- `plugin/install`
- `plugin/uninstall`

Filesystem:

- `fs/readFile`
- `fs/writeFile`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readDirectory`
- `fs/remove`
- `fs/copy`
- `fs/watch`
- `fs/unwatch`

Turns/realtime/review:

- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/realtime/start`
- `thread/realtime/appendAudio`
- `thread/realtime/appendText`
- `thread/realtime/appendSpeech`
- `thread/realtime/stop`
- `thread/realtime/listVoices`
- `review/start`

Models/features/permissions:

- `model/list`
- `modelProvider/capabilities/read`
- `experimentalFeature/list`
- `permissionProfile/list`
- `experimentalFeature/enablement/set`

Remote control:

- `remoteControl/enable`
- `remoteControl/disable`
- `remoteControl/status/read`
- `remoteControl/pairing/start`
- `remoteControl/pairing/status`
- `remoteControl/client/list`
- `remoteControl/client/revoke`

Environment/MCP:

- `collaborationMode/list`
- `mock/experimentalMethod`
- `environment/add`
- `environment/info`
- `mcpServer/oauth/login`
- `config/mcpServer/reload`
- `mcpServerStatus/list`
- `mcpServer/resource/read`
- `mcpServer/tool/call`

Windows/auth/account/feedback:

- `windowsSandbox/setupStart`
- `windowsSandbox/readiness`
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`
- `account/rateLimitResetCredit/consume`
- `account/usage/read`
- `account/workspaceMessages/read`
- `account/sendAddCreditsNudgeEmail`
- `feedback/upload`

Command/process/config/external:

- `command/exec`
- `command/exec/write`
- `command/exec/terminate`
- `command/exec/resize`
- `process/spawn`
- `process/writeStdin`
- `process/kill`
- `process/resizePty`
- `config/read`
- `externalAgentConfig/detect`
- `externalAgentConfig/import`
- `externalAgentConfig/import/readHistories`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`
- `account/read`
- `fuzzyFileSearch/sessionStart`
- `fuzzyFileSearch/sessionUpdate`
- `fuzzyFileSearch/sessionStop`

### App-server notifications

Core notifications include:

- `error`
- `thread/started`
- `thread/status/changed`
- `thread/archived`
- `thread/deleted`
- `thread/unarchived`
- `thread/closed`
- `skills/changed`
- `thread/name/updated`
- `thread/goal/updated`
- `thread/goal/cleared`
- `thread/settings/updated`
- `thread/tokenUsage/updated`
- `turn/started`
- `hook/started`
- `turn/completed`
- `hook/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `item/started`
- `item/autoApprovalReview/started`
- `item/autoApprovalReview/completed`
- `item/completed`
- `rawResponseItem/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `command/exec/outputDelta`
- `process/outputDelta`
- `process/exited`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`
- `item/fileChange/patchUpdated`
- `serverRequest/resolved`
- `item/mcpToolCall/progress`
- `mcpServer/oauthLogin/completed`
- `mcpServer/startupStatus/updated`
- `account/updated`
- `account/rateLimits/updated`
- `app/list/updated`
- `remoteControl/status/changed`
- `externalAgentConfig/import/progress`
- `externalAgentConfig/import/completed`
- `fs/changed`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- `thread/compacted`
- `model/rerouted`
- `model/verification`
- `turn/moderationMetadata`
- `model/safetyBuffering/updated`
- `warning`
- `guardianWarning`
- `deprecationNotice`
- `configWarning`
- `fuzzyFileSearch/sessionUpdated`
- `fuzzyFileSearch/sessionCompleted`
- realtime notifications: `thread/realtime/*`
- Windows sandbox notifications: `windows/worldWritableWarning`, `windowsSandbox/setupCompleted`

## 10. Exec Server

Назначение:

- JSON-RPC server для spawning/controlling subprocesses и filesystem operations.
- Используется для local/remote execution environments.

Команда:

```bash
codex exec-server --listen ws://127.0.0.1:PORT
codex exec-server --listen stdio
codex exec-server --remote wss://... --environment-id <id>
```

Transports:

- local WebSocket `ws://IP:PORT`
- stdio/`stdio://`
- remote mode через registration + rendezvous WebSocket

Remote auth:

- existing ChatGPT sign-in, после `codex login`
- Agent Identity JWT in `CODEX_ACCESS_TOKEN` with `--use-agent-identity-auth`
- `CODEX_API_KEY="$OPENAI_API_KEY"` for API-key bearer on registration

Wire:

- local WebSocket: one JSON-RPC per text frame
- remote: binary protobuf relay frames with encrypted Noise payloads

Lifecycle:

1. `initialize`
2. `initialized`
3. process/fs RPCs
4. WebSocket close terminates remaining managed processes

Exec-server API:

- `initialize`
- `initialized`
- `process/start`
- `process/read`
- `process/write`
- `process/terminate`

Notifications:

- `process/output`
- `process/exited`
- `process/closed`

Filesystem RPCs:

- `fs/readFile`
- internal `fs/open`, `fs/readBlock`, `fs/close`
- `fs/writeFile`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/canonicalize`
- `fs/readDirectory`
- `fs/remove`
- `fs/copy`

Filesystem URIs require `file:` URI form.

API-key remote host validation accepts OpenAI domains or loopback only.

## 11. How a turn works internally

Relevant code path:

- `core/src/thread_manager.rs`
- `core/src/codex_thread.rs`
- `core/src/session/session.rs`
- `core/src/tasks/regular.rs`
- `core/src/session/turn.rs`
- `core/src/client.rs`
- `core/src/tools/orchestrator.rs`

Step-by-step:

1. `ThreadManager` creates/resumes `CodexThread` and stores it in `threads: HashMap<ThreadId, Arc<CodexThread>>`.
2. `Session::new` initializes:
   - thread persistence (`LiveThread`)
   - state DB context
   - auth
   - MCP config and servers
   - telemetry
   - shell snapshot
   - environments
   - AGENTS/user instructions manager
   - plugin/skill warmup
   - network proxy
3. Client sends `turn/start` or CLI calls equivalent in-process API.
4. `RegularTask` emits `TurnStarted`, prepares prewarm if available, then calls `run_turn`.
5. `run_turn`:
   - runs pre-sampling compaction if needed
   - captures `StepContext`
   - records context/world state updates
   - builds skills/plugins/app injections
   - runs session start/input hooks
   - records user input into history
   - builds prompt history with model-compatible modalities
6. `run_sampling_request`:
   - builds `ToolRouter`
   - computes model-visible tool specs
   - builds `Prompt`
   - creates `ToolCallRuntime`
   - streams Responses API
7. Stream events:
   - text deltas become client notifications
   - reasoning deltas become reasoning notifications
   - tool calls are queued as futures
   - token usage and rate limits are persisted/emitted
8. Tool futures resolve through orchestrator.
9. Tool outputs become `ResponseInputItem` and are sent in follow-up sampling requests.
10. If model sets `end_turn=false` or tool output requires follow-up, loop continues.
11. If context budget exhausted, inline compaction runs and turn continues.
12. On final assistant message, stop hooks and legacy after-agent hooks run.
13. Turn completes and events flush.

## 12. Skills, plugins, apps, MCP

Skill/plugin injection is turn-scoped:

- Codex scans user input for explicit skill/app/plugin mentions.
- It loads enabled plugins and skills from config/plugin roots.
- It may prompt/install MCP dependencies for mentioned skills.
- It injects skill instructions as contextual user fragments.
- It merges explicitly enabled connectors/apps into the turn.
- It builds MCP exposure:
  - direct MCP tools
  - deferred MCP tools
  - app/connectors
  - tool suggestion candidates
  - extension tool executors
  - dynamic tools

MCP config lives in `config.toml`, can also be bundled by plugins.

`codex mcp-server` runs Codex itself as an MCP server for another agent/client.

## 13. Running on servers

### CI/headless one-shot

Use `codex exec`.

Recommended:

```bash
export CODEX_API_KEY="$OPENAI_API_KEY"
codex exec --json --skip-git-repo-check "Run tests and summarize failures"
```

For controlled CI:

```bash
codex exec --ignore-user-config --ignore-rules --ephemeral --json "..."
```

Notes:

- prefer API key or `CODEX_ACCESS_TOKEN`
- set `CODEX_HOME` to job-specific directory
- keep secrets out of logs
- avoid `danger-full-access` unless the whole job/container is already disposable

### Long-running local service

Use app-server:

```bash
TOKEN_FILE="$HOME/.codex/app-server-token"
codex app-server --listen ws://127.0.0.1:4500 --ws-auth capability-token --ws-token-file "$TOKEN_FILE"
```

For same-host integrations prefer Unix socket:

```bash
codex app-server --listen unix://
```

Hardening:

- run under dedicated OS user
- isolate `CODEX_HOME`
- lock down `auth.json`
- bind to loopback or Unix socket
- if binding `0.0.0.0`, require auth and put TLS/reverse proxy in front
- do not expose unauthenticated WebSocket over network

### Remote IDE/client to local app-server

Client can connect with:

```bash
codex --remote ws://host:4500
codex --remote unix://
codex --remote unix:///absolute/path.sock
```

Use `--remote-auth-token-env <ENV_VAR>` when server requires bearer token.

### Remote execution environment

Use `codex exec-server` when a controller needs to run commands/filesystem operations inside another host/container.

Remote mode registers an environment and reconnects via service rendezvous WebSocket. The app-server/session layer can then route process/fs operations to that environment.

### Cloud threads

Official Codex cloud threads run in isolated managed environments:

- repository is cloned
- branch is checked out
- setup script can install dependencies
- container state may be cached for faster follow-ups

Local CLI/app-server is different: it runs on your machine or server, with local OS sandboxing and local credentials.

## 14. Operational commands

Diagnostics:

```bash
codex doctor
codex doctor --help
```

App-server schema generation:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

Debug app-server V2 message:

```bash
codex debug app-server send-message-v2 "hello"
```

Headless JSONL:

```bash
codex exec --json "Inspect repo and list risks"
```

Resume:

```bash
codex resume
codex resume --all
codex resume <THREAD_ID>
codex exec resume --last "continue"
```

Update:

```bash
codex update
```

Feature flags:

```bash
codex features
```

## 15. Security checklist for server installs

- Dedicated Unix user per service or environment.
- Explicit `CODEX_HOME` with correct ownership.
- `auth.json` mode owner-only; never in repo.
- API keys injected through secret manager, not files in workspace.
- Prefer `workspace-write` over `danger-full-access`.
- Enable network only when required.
- Prefer Unix socket or loopback app-server.
- Require `--ws-auth` for non-loopback.
- Terminate TLS at reverse proxy for remote WebSocket.
- Use ephemeral workspaces for untrusted tasks.
- Run `codex doctor` before blaming protocol/client bugs.

## 16. Main caveats

- App-server is experimental in public CLI reference.
- WebSocket app-server transport is experimental/unsupported.
- Some app-server methods/fields require `experimentalApi`.
- The app-server wire omits JSON-RPC `"jsonrpc":"2.0"`.
- `thread/session/conversation` naming is mixed in code for backwards compatibility.
- SQLite state is an index, not the only source of truth.
- `ModelClientSession` must be per-turn because of sticky routing.
- API-key authenticated usage follows Platform retention/settings, ChatGPT-authenticated usage follows ChatGPT workspace/RBAC/retention.

## 17. Source map

Install/update:

- [`codex-cli/bin/codex.js`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-cli/bin/codex.js)
- [`scripts/install/install.sh`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/scripts/install/install.sh)
- [`codex-rs/tui/src/update_action.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/tui/src/update_action.rs)
- [`codex-rs/tui/src/updates.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/tui/src/updates.rs)

CLI/runtime:

- [`codex-rs/cli/src/main.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/cli/src/main.rs)
- [`codex-rs/exec/src/lib.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/exec/src/lib.rs)
- [`codex-rs/core/src/thread_manager.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/core/src/thread_manager.rs)
- [`codex-rs/core/src/codex_thread.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/core/src/codex_thread.rs)
- [`codex-rs/core/src/session/session.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/core/src/session/session.rs)
- [`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/core/src/session/turn.rs)
- [`codex-rs/core/src/client.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/core/src/client.rs)
- [`codex-rs/core/src/tools/orchestrator.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/core/src/tools/orchestrator.rs)

Servers/protocol:

- [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/app-server/README.md)
- [`codex-rs/app-server/src/lib.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/app-server/src/lib.rs)
- [`codex-rs/app-server-transport/src/transport/websocket.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/app-server-transport/src/transport/websocket.rs)
- [`codex-rs/app-server-protocol/src/protocol/common.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/app-server-protocol/src/protocol/common.rs)
- [`codex-rs/exec-server/README.md`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/exec-server/README.md)

Persistence:

- [`codex-rs/thread-store/README.md`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/thread-store/README.md)
- [`codex-rs/rollout/src/recorder.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/rollout/src/recorder.rs)
- [`codex-rs/rollout/src/state_db.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/rollout/src/state_db.rs)
- [`codex-rs/message-history/src/lib.rs`](https://github.com/openai/codex/blob/be33f80bc65159c094ecd06bf155afa3061ce23d/codex-rs/message-history/src/lib.rs)
