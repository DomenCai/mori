# 开发指南

本地开发时怎么把它跑起来、改提示词、看日志、调试。当前功能入口见 [文档总览](index.md)，设计历史见 [Design Index](../design/index.md)。

## 前置

- Node ≥ 22.19、pnpm 10（`packageManager` 已锁定版本）
- macOS 通常不需要额外编译器；`better-sqlite3` 默认下载预编译二进制。只有拿不到匹配 prebuild 时才需要 Xcode Command Line Tools 本地编译。

## 数据根：开发态 vs 生产态

同一套代码，运行时状态和用户可改文件都挂在一个 ROOT 下，由 `MORI_DEV` 切换：

| | 开发态（`pnpm dev`） | 生产态（CLI） |
|---|---|---|
| ROOT | 项目内 `./data` | `~/.mori` |
| prompt 文件 | 直接用仓库 `agent/` 内置文件 | `~/.mori/agent/` override + `builtin/` 参考 |
| memory 文件 | 项目内 `data/memory/` | `~/.mori/memory/` |

开发态直接读仓库里的 `agent/` 作为内置 prompt，运行状态和可编辑 memory 写在项目内 `data/`，不会污染 `~/.mori`。

## 首次启动

```bash
pnpm install
pnpm dev
```

`pnpm dev` 设了 `MORI_DEV=1` 并用 `tsx watch` 热重载。首次运行若无飞书配置，终端会渲染二维码，用飞书 App 扫码即可创建/授权应用，凭据自动写入 `data/lark_config.json`，无需手填 appId/secret。日记群、主题群、私聊等 chat 绑定也写在这个文件里，重建 `data/app.db` 不会丢群绑定。

## 配置 LLM

两处配合：

- `data/setting.json` —— 声明 provider、模型、chatType 档位和运行默认值。`apiKeyEnv` 指向环境变量名。
- `.env` —— 填上面 `apiKeyEnv` 对应的 key；`mori setup` 生成的生产配置统一使用 `MORI_API_KEY`。

`chat_types` 直接把 `dm`、`topic`、`thread`、`diary`、`distill`、`daily_memory`、`consolidation`、`review` 映射到一个 `model_profile`。换模型只改 `setting.json`，不动代码。

## 日常开发

- `pnpm dev` —— 前台运行 + 文件改动热重载，日志打到终端并按天落到 `data/logs/YYYY-MM-DD.log`。
- `pnpm build` —— `tsc` 类型检查并编译到 `dist/`，随后复制 `src/storage/schema.sql` 和 `src/storage/migrations/*.sql` 到 `dist/storage/`，再写入 `dist/build-info.json`。发布 tarball 前由 `prepack` 自动触发；源码部署脚本会显式执行。
- 改内置 prompt —— 直接编辑 `agent/` 下的 `soul.md` / `response_style.md` / `memory_policy.md`，下一次构造 system prompt 生效。
- 改画像或当前主线 —— 编辑 `data/memory/profile.md` / `data/memory/chapter.md`，下一次用户 turn 或查看命令会同步进 SQLite。

## 日志

统一走 `src/log.ts`，格式 `MM-DD HH:mm:ss.SSS LEVEL [scope] …`。开发态打到终端，同时按 `setting.time.timezone` 写入 `data/logs/YYYY-MM-DD.log`。

按级别过滤：

```bash
LOG_LEVEL=debug pnpm dev   # debug | info（默认） | warn | error
```

关键路径都有 info 日志：收到消息（发送者/类型/长度）→ 命令处理 → prompt 起止与耗时 → 工具调用 → 回复发送 → cron 触发。排查"是否正常"先看这条链路。

> 扫码向导的提示（二维码、App ID）是面向用户的交互输出，走 `console`，不受 `LOG_LEVEL` 影响 —— 这是有意为之，它不是运行日志。

## 会话文件

Agent transcript 由 pi-agent-core 的 `JsonlSessionRepo` 维护成 JSONL。本应用覆盖了默认的扁平 cwd 编码，改成按 `chatType/月份` 嵌套分桶，例如 `diary/2026-06/`、`dm/2026-06/`、`topic/2026-06/`。文件名用 `setting.time.timezone` 对应的本地时间加 session id，例如 `2026-06-19T01-40-22-483+08-00_<session_id>.jsonl`。

`agent_sessions` 与 `message_session_entries`（见 `src/storage/schema.sql`）是 JSONL transcript 的恢复索引：进程重启或用户回复历史消息时，从这两张表定位 transcript 文件并 reopen。索引只追踪交互式 chat type（`dm` / `topic` / `thread` / `diary`），不收录内部任务（`schedule` / `distill` / `daily_memory` / `consolidation` / `review`）和 backfill。恢复规则见 [会话与冷却规则](sessions.md)。

## Agent runtime

外部调用统一从 `src/agent/index.ts` 导出的 `AgentService` 进入。`AgentService` 管 active agent 池、per-scope lock、会话恢复、idle cleanup 和一次性 agent runner；`HarnessFactory` 负责创建或 reopen pi-agent-core harness、装配工具、注册 `SessionRegistry`；`AgentRuntime` 是 `BaseAgent` 到 harness 的薄壳。

具体运行形态放在 `src/agent/agents/`：`ChatAgent` 覆盖 `dm` / `topic` / `thread`，`DiaryAgent` 覆盖日记群，`DistillAgent` / `WeeklyReviewAgent` / `ConsolidationAgent` / `DailyMemory*Agent` / `ScheduleAgent` 是一次性 agent。业务编排不要直接操作 harness subscribe 模板；新增一次性任务优先通过 `AgentService.withOneShotAgent()` 和具体 `OneShotAgent` 子类暴露的 public `run*` 方法接入。

## 数据库

SQLite（`data/app.db`）。新库完整结构在 `src/storage/schema.sql`；已有库升级 SQL 放在 `src/storage/migrations/*.sql`，文件名前缀数字对应 `PRAGMA user_version`。启动时 `initDb` 会判断是否已有业务表：新库直接执行 schema 并把 `user_version` 设为最新 migration 版本，已有库按版本顺序执行后续 migration。编译产物运行时读取 `dist/storage/` 下复制出的 SQL，开发态可回退读取 `src/storage/`。直接用 `sqlite3 data/app.db` 查表调试。

`messages` 是中性输入模型：每条用户/助手消息带 `source`（`lark` / `import`）、`conversation_id`（完整 scope）、`conversation_type`，飞书 thread 的 `thread_id` 原样保留。飞书消息进核心前先经 `src/lark/ingest.ts` 转成 `IngestedMessage`，记忆层只认 `conversation_id + occurred_at`，不关心来源平台。

## 历史日记导入（backfill）

把 `diary-data/*.md` 历史日记灌进一个全新 DB，逐日/逐周回放记忆演化：

```bash
MORI_DEV=1 pnpm tsx scripts/backfill-diary.ts diary-data
MORI_DEV=1 pnpm tsx scripts/backfill-diary.ts diary-data --dry-run   # 只解析 Markdown 打印计数，不开 DB
```

- 走和线上日记一样的蒸馏路径（`distillDiaryEntry`），每个 `### HH:MM` section 一条 message + 一条 episode，写失败落 fallback episode。
- 默认 `--per-section`（按三级标题拆），`--per-day` 整篇一条、成本更低。
- 按天用独立 session scope（`import:diary:<date>`）跨天 reset，避免全历史挤进一个 harness session。
- 用可注入的模拟时钟（`src/clock.ts`）逐日/逐周推进，daily/weekly 写入的时间戳落在历史日期而非导入当天。
- 不发飞书卡片、不发 nudge、不写 assistant 消息。
- 要求 fresh DB，记忆表非空直接报错；中途失败删 `data/app.db` 重跑即可。

## 测试

遵循根 `CLAUDE.md` 的测试纪律：只测主流程、高风险路径、真实 bug 回归、用户可见行为，不为私有 helper 和不可达状态补测试。端到端测试针对完整链路（记日记 → 流式回复 → 写 episode → 周总结）。

## 发布 npm

包发布为公开的 `@domencai/mori`，可执行命令仍是 `mori`。发布前先确认版本号，再检查真实 tarball：

```bash
pnpm build
npm pack --dry-run
npm publish
```

`prepack` 会重新构建，`package.json#files` 是发布内容白名单。发布后用 `npx @domencai/mori@latest install` 验证全局安装和首次配置；不要从 npx 临时缓存直接启动 daemon。
