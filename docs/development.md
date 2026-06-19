# 开发指南

本地开发时怎么把它跑起来、改提示词、看日志、调试。架构与数据模型见 [实施规划](personal-agent-mvp-impl.md)。

## 前置

- Node ≥ 22.19、pnpm 10（`packageManager` 已锁定版本）
- macOS 需 Xcode Command Line Tools —— `better-sqlite3` 是 native 模块，装依赖时本地编译

## 数据根：开发态 vs 生产态

同一套代码，运行时状态和用户可改文件都挂在一个 ROOT 下，由 `PERSONAL_AGENT_DEV` 切换：

| | 开发态（`pnpm dev`） | 生产态（CLI） |
|---|---|---|
| ROOT | 项目内 `./data` | `~/.personal-agent` |
| 用户可改文件 | 直接用仓库原位文件 | 首次缺失时从仓库 seed 一份 |

开发态直接读写仓库里的 `data/`、`agent/`，改了立刻生效，不会污染 `~/.personal-agent`。

## 首次启动

```bash
pnpm install
pnpm dev
```

`pnpm dev` 设了 `PERSONAL_AGENT_DEV=1` 并用 `tsx watch` 热重载。首次运行若无飞书配置，终端会渲染二维码，用飞书 App 扫码即可创建/授权应用，凭据自动写入 `data/config.json`，无需手填 appId/secret。日记群、主题群、私聊等 chat 绑定也写在这个文件里，重建 `data/app.db` 不会丢群绑定。

## 配置 LLM

两处配合：

- `data/llm-providers.json` —— 声明 provider、模型、路由。`apiKeyEnv` 指向环境变量名。
- `.env` —— 填上面 `apiKeyEnv` 对应的 key（如 `ANTHROPIC_API_KEY=sk-ant-...`）。

路由 `companion`（日常对话）和 `weekly`（周度合并）各自映射到一个 `model_profile`。换模型只改这个 JSON，不动代码。

## 日常开发

- `pnpm dev` —— 前台运行 + 文件改动热重载，日志打到终端并按天落到 `data/logs/YYYY-MM-DD.log`。
- `pnpm build` —— `tsc` 编译到 `dist/`（CLI 安装时由 `prepare` 自动触发，平时不用手跑）。
- 改 agent 提示词 —— 直接编辑 `agent/` 下的 `soul.md` / `response_style.md` / `memory_policy.md`，开发态即时生效。

## 日志

统一走 `src/log.ts`，格式 `MM-DD HH:mm:ss.SSS LEVEL [scope] …`。开发态打到终端，同时按上海日期写入 `data/logs/YYYY-MM-DD.log`。

按级别过滤：

```bash
LOG_LEVEL=debug pnpm dev   # debug | info（默认） | warn | error
```

关键路径都有 info 日志：收到消息（发送者/类型/长度）→ 命令处理 → prompt 起止与耗时 → 工具调用 → 回复发送 → cron 触发。排查"是否正常"先看这条链路。

> 扫码向导的提示（二维码、App ID）是面向用户的交互输出，走 `console`，不受 `LOG_LEVEL` 影响 —— 这是有意为之，它不是运行日志。

## 会话文件

Agent transcript 由 pi-agent-core 的 JSONL session 仓库维护。仓库会按 `cwd` 分桶，早期文件夹名如 `--Users-caidongmeng-Documents-Personal-PersonalAgent--` 是把绝对 cwd 编码后的结果；现在本应用固定使用逻辑分桶 `--personal-agent--`。新 session 文件名使用上海时间，例如 `2026-06-19T01-23-36-218+08-00_<session_id>.jsonl`。

## 数据库

SQLite（`data/app.db`），schema 在 `src/storage/schema.sql`，启动时 `initDb` 幂等建表。直接用 `sqlite3 data/app.db` 查表调试。

## 测试

遵循根 `CLAUDE.md` 的测试纪律：只测主流程、高风险路径、真实 bug 回归、用户可见行为，不为私有 helper 和不可达状态补测试。端到端测试针对完整链路（记日记 → 流式回复 → 写 episode → 周总结）。
