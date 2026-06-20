# 叙事记忆重构（Storyline Memory Redesign）

> 本文定义一次性替换旧 `working_items` 记忆层的目标设计。项目仍在早期，没有真实迁移负担；实现时应直接删除旧工作集和审批机制，不做兼容壳。
> 日期：2026-06-20。本文替代 [`20260619-mvp-to-north-star`](../20260619-mvp-to-north-star/index.md) 中的工作集 / 审批方向。

---

## 1. 核心判断

Personal Agent 的记忆目标不是“保存更多内容”，而是让 Agent 更了解用户，同时避免上下文和记忆无限增长。

现有四层记忆里，`episodes` 是证据层，`profile` 是稳定画像，二者之间缺少“用户生活里正在展开什么”的叙事状态层。`working_items` 试图承载“最近在搞什么”，但字段偏项目管理：`current_questions`、`decisions`、`next_steps`。这适合项目，不适合关系变化、情绪弧线、持续兴趣、自我认知变化等真正产生陪伴感的线索。

因此新增 `storylines`，并用它取代 `working_items`：

- `episode` 回答：某次输入里有什么带证据的观察。
- `storyline` 回答：这些 episode 合起来，说明用户生活里哪条线正在展开。
- `profile` 回答：跨天、跨周稳定反复出现后，Agent 对用户的长期理解是否需要改变。

---

## 2. 统一原则

### 2.1 builtin 是记忆压缩回路

项目里的 builtin 不是普通定时任务，而是记忆整理和压缩回路：

| builtin | 压缩对象 | 输出 |
|---|---|---|
| `daily_memory` | 新 episode / message 信号 + 历史 storylines | `storylines` + daily run 审计 + 可选 check-in |
| `weekly_consolidation` | 一周叙事变化 + episode evidence | `profile` + weekly summary + friend card |
| `knowledge_index` | vault 文件 | knowledge map |

它们共同服务两个目标：让 Agent 更了解用户；避免 memory / prompt 无限膨胀。

### 2.2 记忆层不审批

旧 `working_items` 的审批机制要删除。新的记忆层统一采用：

- 自动写入。
- 完整审计。
- 可通过命令查看和手动纠正。

审批只适合未来不可轻易撤销的外部动作，例如删除真实文件、批量修改用户可见内容、对外发送消息、花钱或调用第三方产生副作用。Agent 对用户的理解是否正确，不应该每天打断用户审批。

### 2.3 不保留兼容壳

实现时直接替换：

- 删除 `working_items` 表和相关代码。
- 删除 `pending_tool_approvals` / `ApprovalService` / 审批卡片。
- 删除 `create_working_item` / `update_working_item` / `merge_working_items` 工具。
- 新增 storylines 相关表、工具、命令和 prompt。

---

## 3. 数据模型

### 3.1 storylines

`storylines` 是唯一的“最近正在发生什么”中间层。

建议字段：

```sql
CREATE TABLE IF NOT EXISTS storylines (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  current_tension TEXT,
  emotional_arc TEXT,
  people_json TEXT NOT NULL DEFAULT '[]',
  evidence_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storylines_status ON storylines(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_storylines_last_active ON storylines(last_active_at);
```

`kind` 第一版枚举：

- `project`
- `relationship`
- `emotional_arc`
- `interest`
- `identity_shift`
- `open_loop`

`status` 只有三态：

- `active`：近期被提及，或仍明显影响当前生活/对话。
- `dormant`：一段时间没被提，但没有结束证据。
- `closed`：用户明确结束，或有足够证据说明这条线已收束。

`closed` 是软关闭，不自动删除；默认不注入，只保留检索和审计。

不要把 `working_items` 的项目管理 DNA 搬进 `storylines`。首版不设 `decisions_json` / `next_steps_json`；项目线或 open loop 的行动信息先写进 `summary` / `current_tension`。等真实使用证明叙事字段不够，再补专用字段。

### 3.2 机械收缩力

`active` 是稀缺位，不能只靠模型自觉收缩。首版用代码提供机械兜底：

- `DORMANT_AFTER_DAYS = 21`：active storyline 若 `last_active_at` 超过 21 天未更新，daily memory 前置步骤直接转 `dormant`。
- `MAX_ACTIVE_STORYLINES = 12`：机械 dormant 后若 active 仍超过 12 条，按 `last_active_at ASC` 把最久未活跃且昨天未命中的线转 `dormant`，直到 active 数量回到上限内。
- 每次机械转 dormant 都写 `storyline_revisions`，`operation = "decay"`，`reason = "mechanical_decay"`。
- `closed` 不自动删除；更早的遗忘只体现在“不注入、不主动提起”，不是销毁证据。

dream prompt 也要知道 active slot 稀缺：新建 storyline 前必须优先尝试延续、合并或唤醒 dormant 线；不能因为“不确定”就保留过多 active。

### 3.3 storyline_revisions

storyline 变更必须可审计。

建议字段：

```sql
CREATE TABLE IF NOT EXISTS storyline_revisions (
  id TEXT PRIMARY KEY,
  storyline_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storyline_revisions_storyline ON storyline_revisions(storyline_id, created_at);
CREATE INDEX IF NOT EXISTS idx_storyline_revisions_run ON storyline_revisions(run_id);
```

### 3.4 daily_memory_runs

`daily_memory_runs` 是每天 06:00 任务的审计入口。dream、nudge 和“不发提醒”的判断都记录在同一条 daily run 里。

建议字段：

```sql
CREATE TABLE IF NOT EXISTS daily_memory_runs (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  input_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  dream_summary TEXT,
  storyline_changes_json TEXT NOT NULL DEFAULT '[]',
  nudge_evaluated INTEGER NOT NULL DEFAULT 0,
  nudge_sent INTEGER NOT NULL DEFAULT 0,
  nudge_text TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`date_key` 用上海自然日，例如 `2026-06-19`。

---

## 4. System Prompt 注入

新 system prompt 的记忆区应该变成：

1. `profile`：始终注入。
2. `storylines`：注入所有 active storylines；可注入最近少量 dormant storylines。
3. fresh episodes：只注入上次 `daily_memory` 之后新增、尚未被 dream 消化的 episodes。
4. `knowledgeIndex`：保留现有知识地图。

旧的“最近 10 条 episode”要改掉。episode 会不断增长，不能作为长期滚动上下文。daily memory 的意义就是把 episode 流压缩进少量 storylines。

---

## 5. Episode 与 Search 命名

`episode` 不是日记专属。它可能来自：

- 日记群根消息。
- 知识卡片反应。
- DM / topic / thread 关闭时的会话蒸馏。

因此 `search_diary` 的概念要改成 `search_memory`：搜索 episode 蒸馏层，并按来源回查原文证据。日记只是 episode 的一种来源，不应该绑定在工具名和 prompt 语义里。

---

## 6. daily_memory

### 6.1 触发语义

`daily_memory` 替代原 `diary_reminder`。

- cron：每天 06:00，Asia/Shanghai。
- 只处理前一上海自然日。
- daemon 没跑就错过，不补跑。
- 错过的内容仍留在 `episodes/messages`，以后可被 search、weekly 或手动命令覆盖。

### 6.2 产品语义

`daily_memory` 是一个 builtin 任务，不是两个对用户可见的任务。内部有两个窄 agent：

- `dream_agent`：维护 storylines。
- `nudge_agent`：判断是否轻触达用户。

不叫 `skipped`。不发提醒是 nudge 内部的合法结果。

执行流程：

0. 无条件先执行机械收缩：把超时 active storyline 转 `dormant`，再应用 active 数量上限。这个步骤每天都跑，独立于昨天是否有 fresh episodes。
1. 收集前一上海自然日的用户信号：fresh episodes、用户消息数量、日记群根消息数量。
2. 有 fresh episodes 时运行 `dream_agent`，把新信号合并进 storylines。
3. 没有用户信号，或连续沉默达到阈值时，运行 `nudge_agent` 判断是否调用 `send_checkin`。
4. 一天只写一条 `daily_memory_runs`；mechanical decay、dream 结果和 nudge 决策都归到这条记录。

nudge 有两个代码层硬闸，不能只靠 prompt 自律：

- `NUDGE_AFTER_SILENT_DAYS = 3`：连续沉默少于 3 天，不进入 nudge 评估。
- `MIN_NUDGE_INTERVAL_DAYS = 7`：距上次实际 `send_checkin` 不足 7 天，`nudge_agent` 当天根本不跑。

代码可继续提供“连续沉默天数、上次 nudge 时间、最近 nudge 文本”等上下文，让 `nudge_agent` 在 prompt 约束下决定是否发送。prompt 要明确：默认不发，避免把陪伴变成打卡。

### 6.3 dream_agent

`dream_agent` 是独立内部 run / harness session：

- 不继承任何日记群、话题群、DM 的聊天上下文。
- 输入由代码组装。
- 禁止 `update_profile`。
- 禁止写 episode。
- 禁止发消息。
- 只写 storylines 和 daily run 审计。

固定注入上下文：

- 昨天所有 fresh episodes 的 brief / observations / source ids。
- 所有 active storylines。
- 最近少量 dormant storylines。
- 最近几次 daily memory run 的简短结果。
- 当前 profile，只读。

可用工具：

- `search_memory(query)`：搜索 episode 并回查证据。
- `get_storyline(id)`。
- `create_storyline`。
- `advance_storyline`。
- `set_storyline_status`。
- `merge_storylines`。

dream 的处理窗口是“昨天”，但判断上下文必须包含历史。它要优先判断“昨天的新信号是否延续已有 storyline”，少开新线。

### 6.4 nudge_agent

`nudge_agent` 也是独立窄 agent：

- 不继承聊天上下文。
- 不能写 profile。
- 不能写 storyline。
- 不能写 episode。
- 只能调用 `send_checkin` tool 或不调用任何工具。

固定注入上下文：

- 连续沉默天数。
- 最近 episode brief。
- active / recent dormant storyline 摘要。
- 最近几次 nudge 的时间和文本。
- prompt 明确默认不发；避免把陪伴变成打卡。

`send_checkin` 的参数就是最终发送给日记群的短文本。是否发送由 agent 决定，但必须通过 tool 执行，便于审计。

nudge 是首版的一部分，不后置到二期。但它必须保持窄边界：

- 只有在没有用户信号，或连续沉默达到代码提供的候选条件时才运行。
- 默认不发；prompt 里明确“不发也是正确决策”。
- 不引用具体负面记忆做主动提醒。
- 不把“昨天没记录”写成打卡式催促。
- 只发一条短文本，不进入连续对话，不写任何长期记忆。

### 6.5 storyline 连续性纪律

storyline 的价值在连续感。dream 不能每天拿新 episode 把同一条线重新命名、重新解释一遍。

工具设计上，首版不要提供任意覆盖式 `update_storyline`。改为窄工具：

- `create_storyline`：只在确实无法归入已有 active/recent dormant 时新建。
- `advance_storyline`：推进已有线，追加新发展、证据和轻量字段微调。
- `set_storyline_status`：只改 `active/dormant/closed`。
- `merge_storylines`：合并重复或高度重叠的线。
- `get_storyline` / `search_memory`：只读追溯。

更新纪律：

- `title` / `kind` 默认稳定，不因每天的新表达随意重命名；只有用户明确重构理解、或 merge 后需要新标题时才改。
- `summary` 可以演进，但应保留原主线，只做增量压缩，不把旧线改写成另一条线。
- `emotional_arc` 记录态度/情绪如何变化，优先写“从 A 到 B”的连续轨迹，不每天覆盖成孤立结论。
- `current_tension` 表达当前张力或悬念，可以随新 episode 更新。
- 每次 advance 必须带 `source_episode_ids` 和 reason，便于 `/storyline <id>` 回查。

---

## 7. weekly_consolidation

weekly 不再更新 storylines。storylines 是 daily memory 的职责。

weekly 的职责只剩两个：

1. 判断这一周的叙事变化是否应该改变长期 `profile`。
2. 生成可回看的周记录和朋友卡。

### 7.1 第一轮：机械 consolidation

第一轮仍在同一个 `weekly_consolidation` session 内运行，允许 `update_profile`，不允许写 storylines。

默认输入：

- 本周 `daily_memory_runs`。
- 本周 touched storylines。
- 本周 episodes 的 brief / observations / evidence。
- 当前 profile。

默认不输入全量日记原文。若需要更新 profile，但 episode evidence 不足，允许用只读工具按需回读相关原文片段。画像变更必须能追到用户证据，不能只基于 daily run 或 storyline 二次总结。

输出：

- `profile_revisions`。
- 客观 recap。
- `weekly_summaries` 记录。
- “这周”卡片。

“这周”卡片不再包含工作集变更和审批提示；改为包含叙事线索变化摘要和画像变更。

### 7.2 第二轮：朋友卡

第二轮复用第一轮同一个 session。第一轮完成并落库后：

- 清空 active tools。
- 追加本周日记群根消息原文。
- prompt 让 Agent 脱下分析帽子，说朋友的话。

第二轮只追加日记群根消息原文；topic / DM / 知识反应不追加原文，它们通过第一轮的 daily runs / storylines / episodes 结构化上下文影响朋友卡。

第二轮 best-effort，失败不影响第一轮已落地结果。

---

## 8. Commands

第一版建议命令：

| 命令 | 作用 |
|---|---|
| `/storylines` | 查看 storylines，默认 active + recent dormant |
| `/storyline <id>` | 查看某条 storyline 的详情、证据和 revisions |
| `/storyline close <id>` | 手动软关闭 |
| `/storyline reopen <id>` | 手动重新激活 |
| `/dream` | 查看最近几次 daily memory run |
| `/dream YYYY-MM-DD` | 查看某天 daily memory 详情 |

`/working` 删除或改为提示使用 `/storylines`。不要长期保留两个入口。

---

## 9. 实施边界

这次改造应一口气替换旧系统：

1. 新增 `storylines`、`storyline_revisions`、`daily_memory_runs`。
2. 删除 `working_items`、`pending_tool_approvals`。
3. 删除 `ApprovalService`、审批卡、approval callback。
4. 删除 working item tools，新增窄 storyline tools：`create_storyline` / `advance_storyline` / `set_storyline_status` / `merge_storylines`。
5. `MemoryService` 改成 profile + storylines。
6. `buildMemorySnapshot` 注入 storylines + fresh episodes。
7. `search_diary` 改名为 `search_memory`。
8. 新增 `daily_memory` builtin，包含 dream + nudge，删除 `diary_reminder` builtin。
9. 重写 `weekly_consolidation` 输入和 prompt。
10. 更新 `agent/memory_policy.md`、README、`docs/memory-model.md`、`design/index.md`。

---

## 10. 非目标

- 不做历史数据迁移。
- 不保留 working item 兼容层。
- 不做向量库。
- 不做自动删除 closed storylines。
- 不让 daily memory 写 profile。
- 不让 weekly consolidation 写 storylines。
- 不让 nudge agent 自由回复；必须通过 `send_checkin` tool。
