# MVP 到北极星设计组

> 日期：2026-06-19。本文是这组 dated design 的入口，整理从 MVP 走向 post-MVP 北极星功能时形成的几份设计。
>
> 状态：存储、知识库、定时任务、会话 scope 仍是这组设计的主要参考；其中“工作集 / working_items / 审批”方向是历史方案，已被 [`20260620-storyline-memory-redesign`](../20260620-storyline-memory-redesign/index.md) 替代。

## 北极星一句话

Personal Agent 是一个飞书优先的对话型个人 Agent，有两根咬合的支柱：

- **支柱 A · 懂我**：记忆系统理解“我是谁、生活里正在展开什么”。
- **支柱 B · 知识库**：Agent 拥有自己的 vault，为成为 T 型通才服务，广度铺多领域，本领域深挖。

知识库不是执行平台，而是第二个输入源 + 第二个反馈回路。用户对知识的反应本身就是关于用户的高质量信号，反哺支柱 A。

## 文档清单

| 文档 | 作用 | 当前状态 |
|---|---|---|
| [`storage-architecture.md`](storage-architecture.md) | 统一存储原则、`messages` 基建表、vault 布局、日记到 `messages` 的重构、SQLite 表去留。 | 仍是存储方向参考；其中 `working_items` 表相关判断按历史背景理解。 |
| [`knowledge-base.md`](knowledge-base.md) | vault + Inbox/Garden、主动收藏、定时投喂、反应晋升、知识地图、知识工具集。 | 仍是知识库方向参考；文中的 `working` 术语按旧记忆层背景理解。 |
| [`scheduled-tasks.md`](scheduled-tasks.md) | builtin / script 任务划分、`schedules.json`、脚本返回契约、worker 隔离、投递流程。 | 仍是定时任务方向参考。 |
| [`conversation-scopes.md`](conversation-scopes.md) | chat 类型、话题 vs 主题群、`sessionPolicy`、scope 边界蒸馏 episode、reply 原文注入。 | 仍是会话生命周期方向参考；记忆快照中的工作集术语已被 storylines 替代。 |
| [`working-item-tools-and-approval.md`](working-item-tools-and-approval.md) | 旧工作集工具拆分和审批卡片机制。 | 历史设计，不再作为待实现目标。 |

## 与 2026-06-20 设计的关系

这组文档先以 `working_items` 作为“最近在搞什么”的中间记忆层，并设计了工具拆分与审批。2026-06-20 的叙事记忆重构重新判断后，把这层改为 `storylines`：

- `working_items` / `pending_tool_approvals` / 工作集审批链路不再是当前目标。
- “关于我”的中间层由 `storylines` 承担。
- 记忆层采用自动写入 + 审计 + 手动纠正，不走日常审批。

因此，阅读本目录时如果遇到工作集字段、工作集工具或审批机制，以 [`20260620-storyline-memory-redesign`](../20260620-storyline-memory-redesign/index.md) 为准。

## 审核关注

- 存储层是否保持“可变即结构化，正文一次写定”。
- `messages` 作为基建日志是否足以支撑 reply 原文注入、知识反应和 episode 来源回查。
- script 任务是否只产出结构化数据，投递、写 Inbox、发通知都由框架处理。
- scope 关闭时的 episode 蒸馏是否靠定时扫描触发，避免临时话题聊完后永不沉淀。
- system prompt 总预算是否仍可控：profile + storylines + fresh episodes + knowledge index 合计不应无限增长。
