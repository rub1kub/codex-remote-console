# Research: Codex GUI поверх серверных сессий

Дата: 2026-07-05.

## Официальная база

- [Codex App Server](https://developers.openai.com/codex/app-server): rich clients должны использовать `codex app-server`; протокол JSON-RPC 2.0 без поля `jsonrpc`, транспорты `stdio`, WebSocket и Unix socket.
- [Codex CLI features](https://developers.openai.com/codex/cli/features): `codex resume` читает локальные transcripts, а remote TUI работает через `codex app-server --listen ws://...` + `codex --remote ...`.
- [Remote connections](https://developers.openai.com/codex/remote-connections): официальный Codex App умеет запускать remote app-server через SSH; сервер дает файлы, tools, credentials, plugins и sandbox.
- [Codex SDK](https://developers.openai.com/codex/sdk): подходит для CI/automation, но для interactive GUI официально рекомендован app-server.

## Найденные решения

- [friuns2/codex-web-ui](https://github.com/friuns2/codex-web-ui): browser UI для Codex Desktop, но опирается на reverse-engineering/minified Electron bundle. Идея полезная, подход хрупкий.
- [0xcaff/codex-web](https://github.com/0xcaff/codex-web): web UI поверх app-server/unix socket. Правильная идея: не патчить Codex, а подключаться к app-server.
- [pavel-voronin/codex-web-local](https://github.com/pavel-voronin/codex-web-local): легкий browser UI, есть password-защита. Полезная идея для локального доступа.
- [jazzyalex/agent-sessions](https://github.com/jazzyalex/agent-sessions): macOS app для просмотра/поиска истории Codex/Claude/Gemini. Сильная часть — session browser, но это не live remote control.
- [AI SDK Codex App Server provider](https://ai-sdk.dev/providers/community-providers/codex-app-server): показывает, что app-server можно обернуть как persistent thread provider с live injection/streaming.
- [Promptfoo Codex App Server provider](https://www.promptfoo.dev/docs/providers/openai-codex-app-server/): запускает локальный `codex app-server` child process и гоняет JSON-RPC, хороший reference для adapter pattern.

## Что улучшено в этой реализации

- Нет reverse-engineering и патча desktop app.
- Нет npm-пакета, который просит Codex/OpenAI токены.
- Нет открытого удаленного WebSocket listener. Приложение использует `ssh -T` и `stdio://`, значит удаленный порт не публикуется.
- История берется через `thread/list` и `thread/read`, а не парсингом JSONL вручную.
- Продолжение работы идет через `thread/resume` + `turn/start`, а не через новый терминальный `codex --yolo`.
- UI намеренно минимальный: server selector, history, chat, composer.

## Security notes

- Сторонние Codex UI проекты надо считать недоверенными, если они просят токены, читают cookies или требуют патчить установленный Codex app.
- Для доступа извне лучше держать этот UI на loopback и заходить через SSH tunnel, Tailscale или reverse proxy с auth.
- Если когда-нибудь использовать `codex app-server --listen ws://0.0.0.0:...`, нужно включать WebSocket auth и TLS; официальный docs прямо предупреждает, что non-loopback listener без auth небезопасен.

