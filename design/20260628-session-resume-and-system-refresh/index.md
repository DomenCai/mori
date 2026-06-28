# 会话恢复与 system prompt 刷新

## 状态

需求定稿，待实现。

本文替代 `docs/sessions.md` 中“内存里还在 -> 续；不在了 -> 新开”的旧目标形态。当前代码仍以 `HarnessManager.entries` 这个进程内 Map 作为唯一续聊依据；本文描述下一版目标语义。

## 背景

当前会话有两个问题：

1. 进程重启或 idle cleanup 后，同一个飞书上下文无法恢复 pi-agent-core 的 JSONL transcript。
2. 主题群 `topic` 默认不自动关闭，长期热 session 的 system prompt 冻结在创建时，拿不到之后更新的 profile、chapter、storylines 和知识地图。

真实 `data/sessions` 里的 JSONL 只有 pi-agent-core session header 和树形 message entry，不保存 system prompt；user message 也是应用层包装后的 prompt，例如 `<my_message>`、`<replied_message>`、`[日记群新日记]`，不是飞书原文。因此：

- JSONL 适合作为 agent transcript 的恢复源。
- SQLite `messages` 适合作为飞书消息血缘和回复定位源。
- 需要新增一层 SQLite 索引把飞书 message、agent session 和 JSONL entry 关联起来。

## 目标

- 支持进程重启后恢复尚未语义关闭的 session。
- 支持用户回复历史消息时，在冷启动场景恢复该消息所属 session。
- 保留 idle close 和 `/new` 作为普通后续消息的新会话边界。
- 每轮使用当前最新 system prompt，解决长寿命主题群记忆冻结。
- 保证记忆源不变时 system prompt 字节级稳定，避免无意义击穿 provider prefix cache。

## 非目标

- 不把 SQLite `messages` 反向拼成主要 LLM history；它只做定位和 fallback 辅助。
- 不把 session registry 放到 `data/sessions/sessions.json`；运行时关系索引用 SQLite。
- 不在第一版实现复杂迁移，把历史 JSONL 全量回填到索引里。
- 不在冷启动发现过期 session 时补跑停机期间错过的蒸馏；先简单关闭并新建。

## 术语

| 术语 | 含义 |
|---|---|
| scope | `IngestedMessage.conversationId`，例如 `lark:chat:<chat_id>` 或 `lark:thread:<chat_id>:<thread_id>` |
| active harness | 当前进程内 `HarnessManager.entries` 里活着的 session |
| agent session | 一个 pi-agent-core JSONL transcript |
| unclosed session | SQLite 中状态仍为 open 的 agent session，可用于进程重启后的默认恢复 |
| closed session | 已被 idle cleanup、`/new` 或过期检查关闭的 session；普通消息不默认恢复 |
| reply-target session | 由 `message.replyTo ?? message.rootId -> message_session_entries` 定位到的历史 session |
| segment | 同一 agent session 内一次连续活动窗口；closed 后再 reopen 会开启新窗口，进程重启恢复 unclosed session 则继续原窗口 |

## 核心规则

### active harness 优先

收到消息时，如果当前 scope 已有 active harness：

- 继续该 active harness。
- 若消息带 `reply_to`，仍然只把父消息内容注入 `<replied_message>`。
- 不因为 `reply_to` 切换、恢复或 reopen 其它 session。

这条规则避免用户在热对话里随手回复前文时，系统突然跳到另一个 transcript。

### 冷启动选择

当前 scope 没有 active harness 时，按以下顺序选择 session：

1. 如果消息带恢复锚点，且能定位到与当前 scope 兼容的 reply-target session：reopen 该 session。
2. 否则查当前 scope 的 unclosed session：
   - `topic`：直接 reopen。
   - `dm` / `thread` / `diary`：按 `last_activity_at + idleMinutes` 判断；未过期则 reopen，已过期则标记 closed 后新建。
3. 否则新建 session。

恢复锚点与 `buildReplyContext` 保持一致，使用 `message.replyTo ?? message.rootId`。第一版 scope 兼容规则先做精确匹配：`reply-target session.scope_id === 当前 scopeId`；跨 scope 回复只注入 `<replied_message>`，不跨 scope reopen。

这是刻意的优先级：冷启动时明确 `reply_to/rootId` 比当前 scope 的 unclosed session 更强。为保证同一 scope 只有一个 open session，reopen reply-target 前要关闭同 scope 下其它 open session。

被 reply-target 抢占的其它 open session 不是“过期 catch-up”场景。若它们按当前 idle policy 尚未过期，关闭前要按当前 segment window 尝试一次 close distillation；若已经过期，则沿用非目标里的取舍，只标 closed，不补跑停机期间错过的蒸馏。

`reply_to` 可以指向 user 消息或 assistant 消息，两者都可作为冷启动恢复锚点。

### reply_to 的稳定职责

`reply_to` 永远负责本轮 prompt 的指代消解：

```text
<replied_message>
被回复消息内容
</replied_message>

<my_message>
当前用户消息
</my_message>
```

无论本轮使用 active harness、reopen session 还是新建 session，只要能找到被回复消息，都注入 `<replied_message>`。

### idle close 与 /new

- idle close 表示释放内存并按现有规则尝试蒸馏当前 segment，不表示 JSONL transcript 永久不可恢复。
- `/new` 表示关闭当前默认后续关系，让下一条普通消息新建 session。
- closed session 仍可在未来被明确 `reply_to` 恢复。
- 普通冷启动消息不恢复 closed session。

### segment 蒸馏

同一个 JSONL session 可以多次 reopen，但 episode 按 segment 分段：

- closed session 被 reply-target 恢复时，开启新的 segment window：清空 `closed_at`、`segment_started_at`、`segment_ended_at`。
- unclosed session 因进程重启被恢复时，继续原 segment：保留已有 `segment_started_at` / `segment_ended_at`，下一条用户消息只更新窗口。
- 新建 session 初始 segment 为空；收到第一条新用户消息时设置 `segment_started_at`。
- 每条用户消息更新 `segment_ended_at`。
- idle cleanup、`/new`、compact 关闭时，只蒸馏当前 segment。
- reply-target 冷启动抢占同 scope 其它未过期 open session 时，也按当前 segment window 先尝试 close distillation，再关闭被抢占 session。
- 冷启动发现 unclosed session 已过期时，简单标 closed 并新建，不补跑旧 segment 蒸馏。
- diary 的 segment window 只为恢复索引一致性维护；日记蒸馏由 `[日记群新日记]` 路径单独处理，不走 close distillation。

## system prompt 刷新

每个用户 turn 都重新生成 system prompt：

```text
syncEditableMemoryFiles()
buildMemorySnapshot()
buildSystemPrompt()
appendSessionInstructions(chatType)
```

要求：

- 不在 system prompt 注入当前时间、随机值、请求 id、hash 或版本号。
- 记忆源不变时，输出必须字节级完全一致。
- SQL 排序必须是全序，例如 `ORDER BY last_active_at DESC, id ASC`、`ORDER BY occurred_at ASC, id ASC`。
- 知识地图注入时过滤 volatile metadata：只过滤 `line.trimStart().startsWith("updated_at:")` 的行，不误删 `last_updated_at:` 等其它字段；`.index.md` 文件本身可以保留该行。
- storylines、fresh episodes 等记忆块可以用 `last_active_at`、`occurred_at` 做选择和排序，但第一版不把这些时间戳渲染进 system prompt。否则 storylines 活跃时间、episode 发生时间这类元数据会造成 prompt cache 不必要失效。
- profile/chapter 文件同步继续使用 content equality gate；内容不变不更新 DB，不新增 revision。

pi-agent-core 支持 `systemPrompt` 传函数并在每轮调用；当前代码传的是创建时渲染好的字符串，实现时应改成函数。该函数在 `createEntry` / reopen 时通过闭包持有 `chatType`、`db`、`memoryService`，不要通过 `resources` 塞应用层状态，也不要每轮按 session id 反查 chatType。

每轮执行 `syncEditableMemoryFiles()`、`buildMemorySnapshot()`、`buildSystemPrompt()` 会带来少量 SQL 和文件读取开销；第一版接受这个 hot path 上的毫秒级开销，优先保证长寿命 session 能拿到最新记忆。

## 数据模型

新增 SQLite 表，作为恢复索引的权威来源。

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  session_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  active_tool_names_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  segment_started_at TEXT,
  segment_ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_scope_status
  ON agent_sessions(scope_id, status, last_activity_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_open_per_scope
  ON agent_sessions(scope_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS message_session_entries (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  entry_id TEXT,
  scope_id TEXT NOT NULL,
  role TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_session_entries_session
  ON message_session_entries(session_id, occurred_at);
```

说明：

- `session_path` 是 reopen JSONL transcript 的来源，存相对 `data/sessions` 的路径，便于迁移；`cwd` 只记录创建时工作目录，用于调试和 metadata 兼容，不作为查找权威字段。
- `entry_id` 用于调试、未来 fork 或定位 transcript；第一版如果 pi-agent-core 不暴露 entry id，可以先写 `NULL`。当前恢复语义使用 session 最新 leaf，不按 entry 截断。
- `active_tool_names_json` 记录创建时工具名快照，避免恢复时工具集漂移。
- 所有 DB 时间字段统一使用 `src/utils.ts` 的 `nowISO()`，即 UTC ISO 字符串。
- `agent_sessions` 只记录交互式 chat type：`diary`、`dm`、`topic`、`thread`。内部一次性任务如 `schedule`、`distill`、`daily_memory`、`consolidation`、`knowledge_index` 不进入这个恢复索引。
- `idx_agent_sessions_one_open_per_scope` 是业务不变量。若历史或异常状态导致同 scope 多个 open session，第一版在恢复路径里选择目标 session 后关闭同 scope 其它 open session；普通 unclosed 恢复时选择 `last_activity_at` 最新的一条并关闭其它条。
- `model_id` 是创建时实际模型记录，只用于审计和调试；恢复时不按它反查模型。

## 写入时机

创建 session：

- `repo.create()` 成功后写 `agent_sessions`。
- 新 session 初始状态为 `open`。

恢复 session：

- 根据 `agent_sessions.session_path` 构造 `JsonlSessionMetadata`。
- `repo.open(metadata)` 后创建新的 `AgentHarness`。
- status 从 `closed` 恢复时改为 `open`，清空 `closed_at`、`segment_started_at`、`segment_ended_at`。
- status 本来就是 `open` 的重启恢复，不清空 segment window，只继续更新。
- profile 选择优先使用 `agent_sessions.profile_name`；若当前 `setting.json` 已删除该 profile，则降级到 `chatTypes[chatType] ?? DEFAULT_PROFILE` 并 log warn，不让旧 session 因配置改名直接不可用。
- 工具集优先使用 `active_tool_names_json` 与当前 `allTools` 的交集；已不存在的工具名 log warn 后丢弃。若存档为空、JSON 损坏或过滤后为空，则降级到当前 `activeToolNamesFor(chatType)` 再按当前 `allTools` 过滤。
- reply-target reopen 且需要关闭同 scope 其它 open session 时，流程必须在 per-scope 锁内执行：
  1. 先读取将被关闭的 session 及其 segment window。
  2. 对未过期且支持 close distillation 的 session，使用 `messages` 表按 segment window 做 best-effort 蒸馏；蒸馏失败只 log warn，不阻断用户本轮消息。
  3. 再开启一个短 SQLite transaction，先关闭其它 open session，再 reopen target。不要在 SQLite transaction 里等待 LLM。
- close distillation 复用现有 `EpisodeSource` 形态：`conversationId = 被抢占 session.scope_id`，`startedAt = segment_started_at`，`endedAt = segment_ended_at`，`messageId = null`。这样沿用 `hasEpisodeForScopeWindow` 的幂等闸门，避免蒸馏已写 episode 但后续 reopen transaction 失败时，下次重试重复落 episode。

用户消息：

- 先保存 `messages`。
- 调 `harness.prompt(...)` 后，记录该用户平台消息对应的 `message_session_entries`。
- `message_session_entries` 写入使用 UPSERT / `INSERT ... ON CONFLICT(message_id) DO UPDATE`，避免飞书事件重试或本地 retry 导致主键冲突。
- 同步更新 `agent_sessions.last_activity_at` 和 segment window。

assistant 回复：

- 保存 assistant 到 `messages` 后，也记录 `message_session_entries`。
- 如果一次 agent 回复实际发出多条飞书 assistant 消息，每条发送成功拿到的 platform message id 都要记录。
- 这样用户未来回复任意一条 assistant 消息时，也能定位 session。

关闭 session：

- idle cleanup 和 `/new` 标记 `agent_sessions.status = 'closed'`、设置 `closed_at`。
- 正常运行中的 idle cleanup 继续按现有 `distillScopeEpisode` 尝试蒸馏当前 segment。
- 冷启动过期检查只标 closed，不补跑蒸馏。

## 并发边界

同一 scope 的 `getOrCreateForMessage`、`harness.prompt`、idle cleanup、`/new` close 和 reply-target reopen 必须串行执行。第一版可以用进程内 per-scope mutex/queue；不需要全局锁。

idle cleanup sweep 不能“先扫出所有候选再批量关闭”；它应逐 scope 获取锁，在锁内重新判断 active/unclosed 状态并关闭对应 session。

这条约束防止两类状态分裂：

- prompt 正在跑时 idle cleanup 把同一个 session 标 closed。
- 冷启动 reply-target reopen 与 unclosed session 恢复同时发生，导致 SQLite open session 和 `HarnessManager.entries` 不一致。

## 恢复算法

伪代码：

```ts
async function getOrCreateForMessage(scopeId, chatType, message) {
  const active = entries.get(scopeId);
  if (active) return active;

  const anchorMessageId = message.replyTo ?? message.rootId;
  const replySession = anchorMessageId
    ? registry.findSessionByMessageId(anchorMessageId)
    : null;
  if (replySession && replySession.scopeId === scopeId) {
    await registry.closeOtherOpenSessionsForReplyTarget(scopeId, replySession.id, policy);
    return await reopenInTransaction(replySession);
  }

  const unclosed = registry.findUnclosedSession(scopeId, chatType);
  if (unclosed) {
    if (!isExpired(unclosed, chatType)) {
      return reopen(unclosed);
    }
    registry.markClosed(unclosed.id);
  }

  return createNew(scopeId, chatType);
}
```

`formatChatPrompt` / `formatDiaryPrompt` 仍负责基于 `message.replyTo ?? message.rootId` 注入 `<replied_message>`；恢复算法不改变 prompt 包装职责。

上述逻辑需要包在同一 scope 的串行队列里执行。

`closeOtherOpenSessionsForReplyTarget` 与 `reopenInTransaction` 的状态更新顺序必须是：

1. `BEGIN`
2. `UPDATE agent_sessions SET status = 'closed', closed_at = ? WHERE scope_id = ? AND status = 'open' AND id != ?`
3. `UPDATE agent_sessions SET status = 'open', closed_at = NULL, segment_started_at = NULL, segment_ended_at = NULL WHERE id = ?`
4. `COMMIT`

SQLite partial unique index 是 immediate constraint，不支持先把 target 置 open 再关闭 others。若 reply-target 本身已经是当前 unclosed session，第 2 步通常 0 行受影响，第 3 步是幂等 reopen 写入，仍按同一流程处理。

`closeOtherOpenSessionsForReplyTarget` 使用 `policy` 只做被抢占 session 的过期判断：

```ts
for (const other of registry.findOtherOpenSessions(scopeId, replySession.id)) {
  if (shouldDistillOnClose(other.chatType) && !isExpired(other, policy)) {
    await tryDistillScopeWindow(other); // best-effort, errors are warned
  }
}
// SQL transaction: close others, then reopen target.
```

## 兼容当前实现

当前 `docs/sessions.md` 中的规则仍是已实现现状。本文实现后需要同步更新：

- `docs/sessions.md`
- `docs/development.md` 的会话文件说明
- `docs/configuration.md` 中 session policy 的含义

历史 JSONL 没有 session registry 记录。第一版可以：

- 不主动回填。
- 从实现上线后开始记录新 session。
- 如需临时恢复旧 JSONL，只提供显式 inspect/import 工具，不放进主流程。

SQLite 变更放在 `src/storage/schema.sql`，使用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 保持幂等。实现完成后再同步更新上面的用户文档。

## 验收点

- topic 主题群重启后，普通消息恢复原 unclosed JSONL session。
- DM/thread 重启后，未超过 idleMinutes 的普通消息恢复原 unclosed session。
- DM/thread idle close 后，普通消息新建 session。
- DM/thread idle close 后，回复旧消息恢复 reply-target session。
- DM/thread/topic 存在未过期 unclosed session 时，冷启动回复旧 closed session 会在切到 reply-target 前，对原 unclosed session 当前 segment 尝试 close distillation。
- 已过期 unclosed session 被冷启动关闭时，仍按第一版取舍不补跑停机期间错过的蒸馏。
- 冷启动时回复跨 scope 消息，只注入 `<replied_message>`，不 reopen 跨 scope session。
- active harness 存在时，回复旧消息不切 session，只注入 `<replied_message>`。
- `/new` 后普通消息新建 session；回复 `/new` 前旧消息仍可恢复旧 session。
- system prompt 连续构造两次，在记忆源不变时输出完全一致。
- `.index.md` 只有 `updated_at` 变化时，注入 system prompt 的知识地图片段不变。
- `storylines.last_active_at`、`freshEpisodes.occurred_at` 变化只影响排序/选择，不作为时间戳文本进入 system prompt。
- 旧 session 记录的 profile/tool 名在当前配置中缺失时，恢复降级并记录 warn，不让飞书本轮消息失败。
- 同一次 assistant 回复拆成多条飞书消息时，回复任意一条都能定位原 session。
- 同一 scope 并发消息、idle cleanup、`/new` 不会产生两个 open session。
