# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js 22+ TypeScript ESM service for a Feishu-first personal agent. Source code lives in `src/`: `main.ts` is the composition root — it boots config, SQLite, the Feishu channel, command routing, agent harnesses, and schedules, and dispatches the CLI (`run`/`start`/`stop`/`status`); `daemon.ts` holds the background daemon lifecycle (start/stop/status with PID-ownership checks). Domain modules are split into `agent/` for pi-agent-core harnesses, prompts, schemas, and tools; `ingest/` for the neutral `IngestedMessage` model shared by all input sources; `diary/`, `memory/`, `retrieval/`, and `storage/` for persistence and FTS; `knowledge/` for vault storage and knowledge files; `lark/` for Feishu integration (message handling, `IngestedMessage` conversion, slash commands, card rendering); and `schedule/` for cron jobs. Editable prompt and policy files live in top-level `agent/`. Current user-facing docs live in `docs/`; dated design material lives under `design/YYYYMMDD-slug/` with a directory-level `index.md`. Runtime data under `data/`, generated output in `dist/`, and local diaries under `diary-data/` are not source artifacts.

## Build, Test, and Development Commands

- `pnpm install` installs dependencies; use pnpm because the lockfile and package manager are pinned.
- `pnpm dev` runs `tsx watch src/main.ts` with `MORI_DEV=1`, so runtime state is read from local `data/`.
- `pnpm build` runs `tsc`, type-checks the project, and writes `dist/`.
- `pnpm start` runs the compiled daemon from `dist/main.js`; run `pnpm build` first.

There is currently no dedicated test or lint script. Use `pnpm build` as the minimum verification before opening a PR.

## Coding Style & Naming Conventions

Use TypeScript with `strict` mode and ESM `NodeNext` imports. Include `.js` extensions in relative runtime imports, matching existing files such as `./storage/db.js`. Follow the current style: 2-space indentation, semicolons, double quotes, named exports, and clear service-style classes. Keep modules focused on one responsibility and avoid adding abstraction layers unless there are multiple real implementations.

## Testing Guidelines

No test framework is configured yet. For behavior changes, add targeted tests only after introducing a test runner and a `pnpm test` script. Prefer high-value coverage around memory updates, SQLite schema/queries, command routing, and Feishu message handling. Name test files after the unit under test, for example `memory/service.test.ts`.

## Commit & Pull Request Guidelines

The repository currently uses Conventional Commits, for example `feat: 初始化飞书个人 Agent`. Keep future commits in the same form: `feat: ...`, `fix: ...`, `docs: ...`, or `refactor: ...`. PRs should include a concise problem statement, the implementation summary, verification commands run, and screenshots or Feishu card examples when UI/card rendering changes.

## Security & Configuration Tips

Do not commit `.env`, `data/setting.json`, `data/lark_config.json`, `data/schedules.json`, `data/app.db*`, `data/sessions/`, logs, or `diary-data/` — the repo ships only `data/setting.example.json` as a template. `setting.json` holds LLM provider/model/route config and references API keys by env-var name (`apiKeyEnv`, e.g. `ANTHROPIC_API_KEY`); the actual keys live in `.env`. Feishu credentials are created by the first-run registration wizard and stored in `data/lark_config.json`.
