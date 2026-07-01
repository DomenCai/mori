# 文档总览

这份目录面向第一次接触 mori 的读者：先从当前功能和运行方式理解系统，再按主题深入。历史设计和取舍记录在 [`design/`](../design/index.md)，当前事实以 `README.md`、本目录和代码为准。

## 快速路径

| 想了解 | 读什么 |
|---|---|
| 这个项目是什么、怎么启动 | [README](../README.md) |
| 命令行安装、守护运行、日志位置 | [CLI 使用指南](cli.md) |
| 飞书里有哪些命令 | [飞书命令](commands.md) |
| 运行时配置、模型路由、提示词、定时任务配置 | [配置参考](configuration.md) |
| agent 的人格、声音定调、嘴上禁令 | [Agent 人格与声音](persona.md) |
| 日记、storylines、daily memory、weekly consolidation | [记忆模型](memory-model.md) |
| scope、续聊、新会话、thread/topic 冷却 | [会话与冷却规则](sessions.md) |
| vault、收藏群、/save、知识工具 | [知识库](knowledge-base.md) |
| weekly summary、daily memory、weekly review、自定义投喂 | [定时任务](schedules.md) |
| 本地开发、调试、数据库、日志 | [开发指南](development.md) |
| 设计历史和后续规划 | [Design Index](../design/index.md) |

## 功能覆盖

| 功能 | 入口 | 文档 |
|---|---|---|
| 飞书扫码注册、创建日记群 | CLI 首次运行、`/new-diary-group` | [CLI 使用指南](cli.md)、[飞书命令](commands.md) |
| 日记群写 episode、流式回复 | 日记群根消息 | [记忆模型](memory-model.md)、[会话与冷却规则](sessions.md) |
| DM / topic / thread 普通对话 | 私聊、`/new-chat`、飞书话题回复 | [会话与冷却规则](sessions.md)、[知识库](knowledge-base.md) |
| 身份画像查看和手动纠错 | 飞书 `/profile` 查看；CLI 修改 | [飞书命令](commands.md)、[CLI 使用指南](cli.md)、[记忆模型](memory-model.md) |
| Storylines 查看和手动开关 | 飞书 `/storylines`、`/storyline` 查看；CLI 开关 | [飞书命令](commands.md)、[CLI 使用指南](cli.md)、[记忆模型](memory-model.md) |
| Daily memory 审计查看 | `/dream` | [飞书命令](commands.md)、[定时任务](schedules.md) |
| 周度合并 | 定时任务、`/consolidate` | [定时任务](schedules.md)、[记忆模型](memory-model.md) |
| 知识收藏与检索 | 自然语言收藏 URL、知识工具、通知话题深聊和 `/clip` 收藏 | [知识库](knowledge-base.md) |
| Script / agent 定时投喂 | `schedules.json` + `.mjs` 脚本或 inline prompt | [定时任务](schedules.md)、[配置参考](configuration.md) |
| 模型/provider 切换 | `setting.json` + `.env` | [配置参考](configuration.md) |
| 本地调试和数据库查看 | `pnpm dev`、`data/app.db`、日志 | [开发指南](development.md) |

## 文档分工

- `README.md` 保持项目入口和最短上手路径。
- `docs/` 记录当前可运行系统的功能、配置、运维和开发事实。
- `design/YYYYMMDD-slug/` 记录 dated design 历史；如果和当前 docs 冲突，以当前 docs 和代码为准。
- `AGENTS.md` 是给协作 agent 的仓库规则，不替代用户文档。
