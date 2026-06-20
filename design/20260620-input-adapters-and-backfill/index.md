# 多入口输入与历史回放设计（Input Sources and Backfill）

> 本文定义 Personal Agent 从“飞书优先”走向“多入口个人输入流”的最小架构边界。
> 日期：2026-06-20。本文补充 [`20260620-storyline-memory-redesign`](../20260620-storyline-memory-redesign/index.md)：记忆层仍以 `episodes` / `storylines` / `profile` 为准；本文只定义输入、输出和历史回放如何接入这套记忆层。

---

## 1. 核心判断

Personal Agent 的核心不是“飞书机器人”，而是“个人输入流记忆系统”。飞书只是第一个实时入口。

现在已经有三个真实入口或近期明确入口：

- 飞书实时消息：当前主要入口，负责日记群、DM、话题、通知群和卡片回复。
- Markdown 历史日记导入：已经存在的 `diary-data/*.md`，不是假想需求。
- 桌面端输入：马上要做，不能继续把核心流程写死在 `@larksuite/channel` 的消息类型上。

因此需要划一条真实边界：**外部入口先转换成内部 message；共享核心只负责保存 message、蒸馏 episode、驱动记忆回放；平台 UI 继续消费 harness 事件并按自己的方式渲染。**

这不是插件系统，也不是通用多平台框架。它只是把已经存在的输入源和马上要做的桌面端从飞书类型里解耦出来，避免后续桌面端接入时重写记忆层。

---

## 2. 统一原则

### 2.1 只抽真实共享核心，不抽平台全集

要抽的是三件事：

- `IngestedMessage`：外部输入进入核心记忆/对话系统的统一消息形状。
- `distillDiaryEntry(...)`：线上日记和历史导入都需要的“保存输入 -> 运行 diary harness -> 保证 episode/fallback”核心函数。
- `Clock` / `now()`：记忆写入用的时间源，历史回放必须能注入模拟时钟。

不要抽一个大而全的 `Channel`、`Adapter` 或 `Sink` 接口。飞书的能力包括卡片、流式更新、reply、thread、群绑定、扫码注册；桌面端的 transport 还未定，可能是本地窗口、IPC、HTTP 或 WebSocket。两边发送形态不一样，强行抽 `send()` / `stream()` 只会把飞书概念搬进桌面端。

`AgentHarness.subscribe(...)` 本身已经是事件流。飞书继续在 `channel.stream(... producer(ctrl) ...)` 闭包里消费这些事件更新卡片；桌面端将来也直接按自己的 transport 消费 harness 事件。首版不再设计 `AgentResponseSink` / `LarkResponseSink` / `DesktopResponseSink` 类层。

### 2.2 输入源真实存在才进入 schema

`source` 可以进入内部 message，因为现在有真实的 `lark`、`import`，并且马上有 `desktop`。这不是为遥远未来预留。实现时可以先落 `lark` / `import`，桌面端 transport 定下来时再加 `desktop` 写入路径。

不要继续往下设计 `telegram`、`wechat`、插件市场、多租户或第三方 connector。没有真实入口前不进代码和 schema。

### 2.3 记忆层不关心平台

`episodes`、`daily_memory`、`storylines`、`weekly_consolidation` 都只关心：

- 用户说了什么。
- 什么时候发生。
- 属于哪个 conversation。
- 是否是新的 diary entry、普通对话、话题或通知反应。

它们不应该知道“这是不是飞书群消息”。飞书、导入、桌面端只是不同输入来源。

### 2.4 fresh DB 直接改名，不做迁移壳

项目仍在早期，本轮历史导入前会删除 DB 重试。因此可以直接把核心表字段改成中性命名，不需要兼容旧 `chat_id` 语义，也不需要写迁移脚本。

旧数据若要保留，应该先另做导出/导入；不要在业务路径里留下长期兼容分支。

---

## 3. 内部消息模型

### 3.1 IngestedMessage

核心层接收的用户消息类型：

```ts
export interface IngestedMessage {
  id: string;
  source: "lark" | "import" | "desktop";
  conversationId: string;
  conversationType: "diary" | "dm" | "topic" | "thread" | "notification";
  role: "user";
  content: string;
  occurredAt: string;
  replyTo?: string | null;
  threadId?: string | null;
  rootId?: string | null;
  knowledgePath?: string | null;
}
```

字段语义：

- `id`：内部唯一消息 id，必须带 source namespace，例如 `lark:om_xxx`、`import:diary:2026-03-06:23-16`、`desktop:msg_xxx`。
- `source`：真实输入源，用于调试、查询和后续 UI 过滤。
- `conversationId`：核心会话 id，不等同于飞书 chat id。它是完整 scope，若消息属于飞书 thread，必须包含 thread 维度。
- `conversationType`：核心路由类型，决定走 diary、DM、topic、thread 或 notification 语义。
- `occurredAt`：消息真实发生时间。历史导入用日记文件名和三级标题构造。
- `replyTo` / `threadId` / `rootId`：中性 thread/reply 元数据。飞书的 `threadId` 不能丢弃，必须原样存入 `threadId`；它用于回查、reply、UI 关联和调试，但不再用于重新拼核心 scope。import 默认为空。

### 3.2 conversationId 规则

首版直接用可读、稳定的字符串：

| 来源 | 场景 | conversationId |
|---|---|---|
| Lark | 日记群 / DM / 普通群 | `lark:chat:<chat_id>` |
| Lark | 话题 / thread | `lark:thread:<chat_id>:<thread_id>` |
| Import | 历史日记 | `import:diary` |
| Desktop | 日记入口 | `desktop:diary` |
| Desktop | 普通对话 | `desktop:conversation:<id>` |

`conversationId` 就是完整 scope。核心层回读时间窗 episode 时只按 `conversation_id + occurred_at window` 查，不再 `splitScopeId()`，也不再靠 `chat_id + thread_id` 重新拼 scope。

`threadId` 仍然保存：它是外部平台元数据，不是核心 scope 的组成逻辑。也就是说，飞书 thread 消息会同时满足：

- `conversationId = lark:thread:<chat_id>:<thread_id>`
- `threadId = <thread_id>`

这样既不会丢飞书 thread id，也避免 scope 查询路径有两套状态。

### 3.3 messages 表

fresh DB 下建议直接改成中性字段：

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to TEXT,
  thread_id TEXT,
  root_id TEXT,
  knowledge_path TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, occurred_at);
```

`occurred_at` 是平台/历史事件时间；`created_at` 是本系统落库时间。实时消息两者通常接近，历史导入会明显不同。

assistant message 也写入同一张表，并且必须带 `source`、`conversation_id`、`conversation_type`。它的 `source` 表示这条回复发往哪个来源，例如飞书卡片回复就是 `lark`；历史导入不保存 assistant message。

### 3.4 episodes 来源字段

`episodes` 也应该从飞书 scope 语义改成内部 conversation 语义：

```sql
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  source_conversation_id TEXT NOT NULL,
  source_message_id TEXT,
  source_started_at TEXT NOT NULL,
  source_ended_at TEXT NOT NULL,
  brief TEXT,
  analysis_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  digested_run_id TEXT,
  created_at TEXT NOT NULL
);
```

规则：

- 单条消息蒸馏的 episode 必须带 `source_message_id`。
- 关闭 DM/topic/thread 时对一段时间窗做蒸馏，`source_message_id = null`。
- `source_message_id` 指向内部 `messages.id`，不是飞书原始 message id。
- 时间窗 episode 回读原文时，只使用 `source_conversation_id + [source_started_at, source_ended_at]`。
- `created_at` 是本系统写 episode 的时间；历史 backfill 需要能传入历史时钟，否则审计时间会全落在导入当天。

---

## 4. 共享核心边界

### 4.1 Lark 入口

职责：

- 把 `NormalizedMessage` 转成 `IngestedMessage`。
- 维护飞书 chat binding、扫码注册、群创建、通知群创建等飞书专属逻辑。
- 判断飞书消息属于 diary、DM、topic、thread、notification 哪类 conversation。
- 在 `channel.stream(... producer(ctrl) ...)` 里直接订阅 harness event，更新现有飞书卡片。

`messageHandlers.ts` 不应该长期直接把 `NormalizedMessage` 传进核心 memory/message service。它可以保留飞书 UI 逻辑，但进入核心前要先转换。

### 4.2 Markdown 导入入口

职责：

- 读取 Markdown 历史日记。
- 按文件名和三级标题拆成 `IngestedMessage`。
- 调用 `distillDiaryEntry(...)` 写 `messages` 和 `episodes`。
- 不模拟 assistant 回复、不往飞书发送历史卡片。

导入是一个真实输入源，不是绕过业务逻辑的 SQL loader。它应该尽量走和 diary entry 一样的 episode 蒸馏路径。

### 4.3 桌面端入口

职责：

- 接收桌面端 UI 的用户输入，转成 `IngestedMessage`。
- 按桌面端实际 transport 消费 harness event，并返回 UI。
- 桌面端具体用 Tauri IPC、本地 HTTP、WebSocket 还是别的 transport，不影响核心层。

桌面端不是飞书的替代实现；它是另一个输入来源和 UI transport。传输方案未定前，不提前写 `DesktopAdapter` / `DesktopResponseSink` 类。

---

## 5. distillDiaryEntry

真正要复用的是日记蒸馏核心，而不是平台发送接口：

```ts
async function distillDiaryEntry(opts: {
  harnessManager: HarnessManager;
  message: IngestedMessage;
  sessionScope?: string;
}): Promise<{ fallbackReason?: string }>;
```

它负责：

1. 保存用户 message。
2. 构造 `EpisodeSource`，其中 `source_conversation_id = message.conversationId`、`source_message_id = message.id`。
3. 选择或创建 diary harness scope。默认 `sessionScope = message.conversationId`，但导入必须显式传独立 session scope。
4. 设置 active tools 为 `["write_episode", "search_memory"]` 或导入场景所需的最小集合。
5. 运行 diary entry prompt。
6. 确保 episode 存在，失败时落 fallback episode。

它不负责：

- 飞书卡片渲染。
- 桌面端 UI 推送。
- 保存 assistant message。
- thread/reply UI 行为。

线上飞书 handler 继续在自己的 stream 闭包里订阅 harness event 更新卡片；导入脚本直接调用这个函数，不订阅 UI 事件；桌面端将来按实际 transport 自己订阅事件。

### 5.1 conversationId 与 sessionScope

`conversationId` 是存储和回读用的逻辑会话；`sessionScope` 是 harness transcript 的上下文边界。两者默认可以相同，但历史导入必须解耦。

原因：所有历史日记的 `conversationId` 都是 `import:diary`。如果导入 150 到 250 个 section 时直接用 `conversationId` 作为 harness scope，会把整段历史塞进同一个 diary session，撑爆上下文。旧 `scripts/import-diary.ts` 用 per-date ephemeral scope 正是为了规避这个问题。

规则：

- 实时飞书日记：`sessionScope = message.conversationId`，保留日记群连续上下文。
- 桌面端实时日记：首版也可 `sessionScope = message.conversationId`，保留桌面日记连续上下文。
- Markdown 导入：`sessionScope = import:diary:<date>`；同一天 section 可以共享 session，跨天必须 `resetSession(sessionScope)`。
- `--per-day` 导入：每天一条 message，也使用 `sessionScope = import:diary:<date>`，处理完当天后 reset。

对 diary scope 调 `resetSession` 不应额外蒸馏一条会话 episode；diary entry 已经逐条写 episode，关闭 session 只用于释放上下文。

---

## 6. 历史日记导入

### 6.1 Markdown 拆分规则

`diary-data/YYYY-MM-DD.md` 按三级标题拆分：

```md
### 00:36
第一条日记

### 23:16
第二条日记
```

导入为两条 message：

```text
id = import:diary:2026-03-06:00-36
conversationId = import:diary
conversationType = diary
occurredAt = 2026-03-06T00:36:00+08:00
content = 第一条日记

id = import:diary:2026-03-06:23-16
conversationId = import:diary
conversationType = diary
occurredAt = 2026-03-06T23:16:00+08:00
content = 第二条日记
```

细节：

- `### HH:MM` 是时间元数据，不放进 message content。
- 同一天同一分钟出现多条时，id 追加序号：`import:diary:2026-03-06:23-16:02`。
- 文件开头若存在第一个三级标题之前的正文，使用当天 `09:00` 作为 occurredAt，并生成 `import:diary:<date>:09-00:prelude`。
- 没有任何三级标题的文件，整篇作为一条 `09:00` 日记导入。
- 空 section 跳过。

按 section 拆比“每天一条”更接近真实使用：用户一天可能多次记录，每次记录都是独立输入。daily memory 看到的证据粒度也更自然。

### 6.2 导入流程

历史导入不直接写 episode SQL。它走 diary entry pipeline：

```text
Markdown section
-> toIngestedMessage()
-> distillDiaryEntry(message, sessionScope=import:diary:<date>)
-> write_episode
-> fallback episode if needed
-> resetSession(import:diary:<date>) after the date is complete
```

每条历史日记都应该生成一条 source message 和一条 episode。失败时保留 source message，并保存最小 fallback episode，保证后续 daily memory 不丢证据。

### 6.3 旧脚本处理

现有两个脚本不再保留为正式入口：

- `scripts/import-diary.ts`：只覆盖“整篇日记 -> episode”，粒度和后续 backfill 不够。
- `scripts/test-consolidation.ts`：适合临时测试，但会直接发飞书卡片，不适合作为历史导入编排。

正式入口改为一个脚本：

```bash
PERSONAL_AGENT_DEV=1 pnpm tsx scripts/backfill-diary.ts diary-data
```

默认行为：

1. 要求目标 DB 是 fresh DB，非空直接报错。
2. 按 section 导入所有历史日记。
3. 同一天 section 使用同一个导入 session scope；日期结束后 reset，避免全历史挤进一个 harness session。
4. 按上海自然日顺序跑 daily memory。
5. 按 ISO 周顺序跑 weekly consolidation。
6. 不发送飞书卡片，不发送 nudge。
7. 打印 messages、episodes、daily runs、storylines、weekly summaries、profile revisions 的统计结果。

### 6.4 section 粒度与成本

默认按 `### HH:MM` section 拆，忠于线上“每条日记群根消息生成一条 episode”的模型。但这会显著增加 LLM 调用：

- 38 个日记文件可能变成 150 到 250 条 section。
- 每条 section 至少一次 `write_episode`。
- 后续还有每日 dream 和每周 consolidation。

首版保留两个开关：

- `--per-section`：默认，按三级标题拆。
- `--per-day`：整篇日记作为一条 message，适合低成本试跑。

短 section 不做自动合并，避免把隐含语义合错；如果真实跑下来噪声过大，再加显式 `--merge-short-sections <chars>`，默认不启用。

---

## 7. Daily Memory Backfill

### 7.1 模拟时钟

历史回放要“逐日/逐周演化”，不能只给 `runDailyMemoryForDate()` 传一个 `now` 参数。所有会写时间戳的记忆路径都必须使用同一个可注入时钟：

```ts
export interface Clock {
  now(): Date;
  nowISO(): string;
}

export interface MutableClock extends Clock {
  set(date: Date): void;
}
```

首版可以把一个 `MutableClock` 注入 `HarnessManager` 及其持有的 service。backfill 串行执行，每个模拟日/周开始前调用 `clock.set(date)`；本轮内所有 tools 和 service 写入都读同一个 `clock.nowISO()`。实时 daemon 使用固定的 system clock 实现即可。

必须改掉的写入点：

- `MessageService.saveUserMessage` / `saveAssistantMessage` 的 `created_at`。
- `DiaryService.saveEpisode` 的 `created_at`。
- `createStoryline` / `advanceStoryline` / `setStorylineStatus` / `mergeStorylines` 的 `created_at`、`updated_at`、`last_active_at`。
- `storyline_revisions.created_at`。
- `profile_revisions.created_at` 和 `profile.updated_at`。
- `daily_memory_runs.created_at` / `updated_at` / `nudge_sent_at`。
- `weekly_summaries.created_at`。
- `agent_runs.created_at`。

否则 backfill 时 storyline 活跃时间、机械衰减、weekly 窗口过滤都会塌到导入当天。

### 7.2 runDailyMemoryForDate

现有 `runDailyMemory()` 写死处理前一上海自然日。历史回放需要拆出明确日期入口：

```ts
async function runDailyMemoryForDate(opts: {
  dateKey: string;
  clock: MutableClock;
  nudge: boolean;
}): Promise<void>
```

语义：

- `dateKey`：被处理的上海自然日。
- `clock`：可推进模拟时钟；运行前 set 到 `dateKey + 1 day 06:00 +08:00`。
- `nudge=false`：历史回放默认不触发轻触达。
- episode 查询窗口是 `occurred_at < endOf(dateKey)` 且 `digested_run_id IS NULL`。
- 写 `daily_memory_runs`、`storyline_revisions`、`storylines.updated_at/last_active_at` 时使用 `clock`，不能用导入当天的真实当前时间。

### 7.3 是否补跑空白日

backfill 默认从第一条历史日记日期跑到最后一条历史日记日期，每个上海自然日都跑一次 daily memory。

理由：

- 空白日不跑 dream，不增加 LLM 成本。
- 机械收缩需要真实经过的天数，不能只在下一条日记出现时才触发。
- daily run 审计会更接近真实 daemon 每天 06:00 的行为。

如果未来觉得空白 daily run 太多，可以加显式参数跳过；首版不要默认跳过。

### 7.4 nudge 与导入数据

历史导入会写入大量 `source = 'import'` 的 user message。回放期间 `nudge=false`，不会发送轻触达；回放完成后，实时 daemon 的 nudge 判断也不能把 import 消息当成“用户刚刚活跃”。

nudge 的最近用户活跃查询应只看实时来源：

```sql
WHERE role = 'user' AND source != 'import'
```

如果以后桌面端是实时入口，`desktop` 应该计入活跃；只有历史导入不计入。

---

## 8. Weekly Consolidation Backfill

### 8.1 runWeeklyConsolidationForWindow

周合并需要明确窗口和输出策略：

```ts
async function runWeeklyConsolidationForWindow(opts: {
  since: string;
  until: string;
  clock: MutableClock;
  sendCards: boolean;
  friendRound: boolean;
}): Promise<void>
```

语义：

- `since` / `until` 是半开区间 `[since, until)`。
- episode 查询必须同时有下界和上界，不能只用 `since`。
- daily runs 和 storyline revisions 也按窗口过滤。
- `clock` 运行前 set 到该 ISO 周周日 `23:55 +08:00`。
- `sendCards=false` 时不调用飞书 channel，只落 `weekly_summaries`、`profile_revisions`、`agent_runs`。
- `friendRound=false` 为历史 backfill 默认值，避免批量导入时额外生成大量散文卡片；需要历史朋友文本时再显式打开。

### 8.2 周窗口

backfill 按上海日历的 ISO 周回放：

1. 找到第一条历史 message 的 week start。
2. 找到最后一条历史 message 的 week end。
3. 每周先确保该周内所有 daily memory 已跑完。
4. 再运行该周的 weekly consolidation。

这样 profile 是沿时间顺序逐周演化，而不是一次性看完所有历史后生成一个大画像。

如果不完成 §7.1 的模拟时钟注入，本节的逐周演化承诺不成立。实现时必须先完成 clock，再做 weekly backfill。

---

## 9. 桌面端接入形态

桌面端首版只需要接两条核心路径：

- diary entry：用户在桌面端写日记，走 `conversationType = "diary"`。
- companion chat：用户在桌面端普通聊天，走 `conversationType = "dm"` 或 `topic`。

桌面端不需要实现飞书群绑定、通知群、卡片语法或 thread reply。它只需要：

1. 生成稳定 message id。
2. 生成稳定 conversation id。
3. 传入 `IngestedMessage`。
4. 按实际 transport 消费 harness event。

桌面端做起来后，同一套 daily memory 和 weekly consolidation 会自然处理桌面输入，不需要再为桌面端重写记忆逻辑。是否需要桌面端专用类，等 Tauri / HTTP / WebSocket 等 transport 方案确定后再决定。

---

## 10. 实施顺序

### Phase 1：中性 message schema

- 修改 `messages` 和 `episodes` schema 为中性字段。
- 新增 `IngestedMessage` 类型。
- `MessageService.saveUserMessage()` 改为接收 `IngestedMessage`。
- Lark 入口增加 `toIngestedMessage()` 转换，保留飞书原始 `threadId`。
- `conversation_id` 定为完整 scope，飞书 thread conversation 必须包含 `thread_id`。
- 更新 message 查询函数，按 `conversation_id` / `occurred_at` 查询，删除 `splitScopeId()` / `scopeIdForMessage()`。
- `saveAssistantMessage()` 同步写入 `source`、`conversation_id`、`conversation_type`。

### Phase 2：日记蒸馏核心

- 抽 `distillDiaryEntry(...)`。
- `distillDiaryEntry(...)` 必须支持 `sessionScope`，默认等于 `message.conversationId`，导入时按天传入 `import:diary:<date>`。
- 飞书 handler 保留现有 `channel.stream` + 卡片逻辑，只复用蒸馏和 fallback 核心。
- import 直接调用 `distillDiaryEntry(...)`，不保存 assistant message。
- 不抽象扫码、建群、通知群、飞书卡片能力，也不新增 Sink 类层。

### Phase 3：模拟时钟与 backfill builtin

- 给 `HarnessManager`、`MemoryService`、`DiaryService`、`MessageService` 和相关 tools 注入 `MutableClock`。
- 所有 profile、storyline、daily、weekly、agent run 写入都使用 `clock.nowISO()`。
- 实现 `runDailyMemoryForDate()`。
- 实现 `runWeeklyConsolidationForWindow()`，包含半开窗口上界。
- nudge 最近活跃查询排除 `source = 'import'`。

### Phase 4：历史日记脚本

- 删除或替换现有 `scripts/import-diary.ts` 和 `scripts/test-consolidation.ts`。
- 新增 `scripts/backfill-diary.ts`。
- 实现 Markdown section parser。
- 按日期设置导入 `sessionScope`，每天结束后 `resetSession`。
- 默认 fresh DB、禁用 nudge、禁用 sendCards、禁用 friendRound。
- 默认 `--per-section`，提供 `--per-day`。

### Phase 5：桌面端入口

- 根据实际桌面技术栈接入 `IngestedMessage` 和 harness event。
- 桌面端 diary 和 companion chat 先接核心 pipeline。
- 桌面端的设置、历史列表、搜索、weekly 展示等 UI 后续再做，不阻塞核心接入。

---

## 11. 非目标

- 不做通用插件系统。
- 不做 Telegram / WeChat / Slack 等未确认入口。
- 不做多租户。
- 不保留旧 DB schema 兼容。
- 不把飞书卡片能力抽象成所有平台都要实现的通用 Channel。
- 不新增 `AgentResponseSink` / `LarkResponseSink` / `DesktopResponseSink` 类层。
- 不把 Markdown 导入做成支持所有日记格式的通用解析器；首版只支持当前 `YYYY-MM-DD.md` + `### HH:MM`。
- 不让历史导入模拟 assistant 回复历史。
- 不在历史 backfill 中发送 nudge 或刷飞书历史周报。

---

## 12. 验证

最小验证：

```bash
pnpm build
PERSONAL_AGENT_DEV=1 pnpm tsx scripts/backfill-diary.ts diary-data
```

导入后检查：

- `messages` 数量等于 Markdown section 数量。
- 飞书 thread 消息保留 `thread_id`，且 thread conversation 的 `conversation_id` 包含 thread 维度。
- 每条 import message 都有对应 episode。
- `daily_memory_runs` 覆盖第一条日记到最后一条日记之间的每个上海自然日。
- `episodes.digested_run_id` 不为空。
- `storylines` 有合理 active/dormant 分布。
- `storylines.updated_at/last_active_at`、`storyline_revisions.created_at` 落在模拟日期附近，不是导入当天。
- `messages.created_at`、`episodes.created_at` 在历史导入时也使用模拟时钟，或在实现文档中明确标为纯审计字段；首选使用模拟时钟。
- `weekly_summaries` 按 ISO 周生成。
- `profile_revisions` 只来自 weekly consolidation。
- 没有发送飞书消息，没有发送 nudge。

如果 backfill 中途失败，首版不做复杂断点恢复。因为目标是 fresh DB，可删除 DB 后重跑。
