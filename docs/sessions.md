# 会话与冷却规则

Agent 对每个飞书 scope 维护一个独立对话上下文，并按 `setting.json` 的 `sessions.policies` 自动回收空闲 scope。这份文档讲清楚：什么时候算"接着上一轮聊"，什么时候算"开了个新会话"。

实现见 `src/agent/harness.ts`（`HarnessManager` + `getOrCreateForMessage`）、`src/agent/sessionRegistry.ts`（恢复索引）与 `src/main.ts` 的清理定时器；配置字段见 [配置参考](configuration.md)。

## scope key

scope key 就是 `IngestedMessage.conversationId`，是完整 scope：

| 类型 | scope key |
|---|---|
| 日记群 / 私聊 / 主题群 | `lark:chat:<chat_id>` |
| 飞书话题 thread | `lark:thread:<chat_id>:<thread_id>` |
| 历史日记导入 | `import:diary:<date>`（按天一段，跨天 reset，见 [开发指南](development.md)） |
| 内部任务 | `weekly_consolidation` / `daily_memory_*` / `knowledge_index_*` 等内部 scope |

## 续聊 vs 新会话

`HarnessManager.getOrCreateForMessage(scopeId, chatType, message)` 按下面的顺序决定本轮 session：

1. **active harness 命中**：当前进程内存里这个 scope 还有活着的 harness，直接续。
2. **reply-target 恢复**（冷启动场景）：消息带 `reply_to`（或 `root_id`），且这个 message id 能从 `message_session_entries` 索引定位到当前 scope 内的某个 agent session，则 reopen 那条 session；reopen 前会关掉同 scope 其它 open session（不变量：同一 scope 同时只有一个 open）。
3. **unclosed session 恢复**（重启后默认路径）：当前 scope 在 `agent_sessions` 里有 status='open' 的记录：
   - `topic`：直接 reopen。
   - `dm` / `thread` / `diary`：按 `last_activity_at + idleMinutes` 判断；未过期 reopen，已过期标 closed 后新建。
4. **新建 session**。

`reply_to` 永远负责本轮 prompt 的指代消解：无论本轮是续聊、恢复还是新建，只要能找到被回复消息，就注入 `<replied_message>`。active harness 存在时，回复历史消息不会切到旧 session，只是注入引用。

跨 scope 回复（reply-target session 不在当前 scope）不会跨 scope reopen，仍是当前 scope 新建/续聊 + 注入 `<replied_message>`。

## 关闭与 segment

| 触发 | 含义 | 蒸馏行为 |
|---|---|---|
| 空闲关闭（idle cleanup） | 满足 `sessions.policies.<chatType>` 的 `idleMinutes` | 关闭前按当前 segment 尝试蒸馏（`dm` / `topic` / `thread`） |
| `/new` | 手动重置当前 scope | 关闭前蒸馏当前 segment |
| `/compact` | 压缩当前会话 | 关闭前蒸馏；之后下条消息走冷启动新建 |
| 进程重启 | 内存清空 | 不蒸馏；下条消息按 unclosed session 恢复路径处理 |
| reply-target 冷启动 reopen | 同 scope 其它 open session 被抢占 | 抢占前对未过期且支持蒸馏的 session 按当前 segment 做 best-effort 蒸馏 |

closed session 不再被普通后续消息默认续，但仍可被明确 `reply_to` 一条该 session 内的消息恢复。

## segment 与 episode

同一个 JSONL session 可以多次 reopen，episode 按 segment 分段：

- closed 后被 reply-target 恢复 → 新 segment（`segment_started_at` / `segment_ended_at` 清空）。
- 进程重启恢复 unclosed session → 沿用原 segment 窗口。
- 新建 session 初始 segment 为空；首条用户消息设 `segment_started_at`，之后每条用户消息扩 `segment_ended_at`。
- 关闭路径（idle / `/new` / `/compact` / reopen 抢占）只蒸馏当前 segment。
- 冷启动发现过期 unclosed session 时简单标 closed，不补跑停机期间错过的蒸馏。
- diary 的 segment 窗口只为恢复索引一致性维护；日记蒸馏由 `[日记群新日记]` 路径单独处理。

## sessions.policies

默认策略在 `data/setting.example.json`：

```jsonc
"sessions": {
  "sweepIntervalMs": 300000,
  "policies": {
    "diary":  { "autoClose": true,  "idleMinutes": 60 },
    "dm":     { "autoClose": true,  "idleMinutes": 120 },
    "thread": { "autoClose": true,  "idleMinutes": 30 },
    "topic":  { "autoClose": false }
  }
}
```

后台按 `sweepIntervalMs` 扫一遍内存中所有会话条目，逐 scope 拿锁判断是否关闭：

- `autoClose: false`：不自动关闭，只能靠 `/new`、`/compact` 或进程重启收束。
- `autoClose: true`：`当前时间 - lastActivityAt > idleMinutes` 时关闭。
- `thread` 默认 30 分钟空闲关闭；`topic` 默认不自动关闭。

冷启动恢复 unclosed session 时也用同一份 policy 判断是否过期；`topic` 没有 `idleMinutes`，重启后任意时间内都会 reopen 原 session。

## 恢复索引

SQLite 两张表（见 `src/storage/schema.sql`）：

- `agent_sessions`：每条 JSONL transcript 一行，含 scope、chat type、profile、tool 快照、status、segment window。`(scope_id, status='open')` 上有 partial unique index 保证同 scope 任一时刻最多一个 open。
- `message_session_entries`：飞书 message id → agent session id 的映射。每条用户消息和发出的 assistant 消息都登记一条；DM 一轮回多条消息时，每条都登记。

只有 `dm` / `topic` / `thread` / `diary` 会写入这两张表；内部一次性 scope（`schedule` / `distill` / `daily_memory` / `consolidation` / `knowledge_index`）和 diary backfill 不写。

## 并发边界

同一 scope 的 `getOrCreateForMessage`、`harness.prompt`、idle close、`/new`、`/compact` 与 reply-target reopen 都在同一个 per-scope 串行队列里跑。这条约束防止两类状态分裂：

- prompt 正在跑时 idle cleanup 把同一个 session 标 closed。
- 冷启动 reply-target reopen 与 unclosed session 恢复同时发生，导致 SQLite open session 与 `HarnessManager.entries` 不一致。

## system prompt 刷新

每个用户 turn 都重新生成 system prompt（`syncEditableMemoryFiles` → `buildMemorySnapshot` → `buildSystemPrompt` → `appendSessionInstructions`），以让长寿命主题群也能拿到之后更新的 profile、chapter、storylines、知识地图。

为了在记忆源不变时维持 provider prefix cache：

- system prompt 不注入时间戳、随机值、请求 id、hash 或版本号。
- storylines / fresh episodes 用 `last_active_at` / `occurred_at` 做选择和排序，但这些时间戳不渲染进 system prompt 文本。
- 知识地图注入时过滤 `updated_at:` 行（不误伤 `last_updated_at:` 等）；`.index.md` 文件本身可保留该行。
- 内存源完全不变时，连续两次构造的 system prompt 字节级相同。

## 会话类型从哪来

收到消息时，先用 `ChatRegistry.getType(chatId)` 从 `lark_config.json.chatBindings` 查群类型；私聊若未注册会自动登记为 `dm`。如果消息带 `threadId`，会优先作为 `thread` scope 处理。类型决定模型路由、工具集、是否按 `sessions.policies` 自动关闭。

`consolidation`、`daily_memory`、`knowledge_index`、`distill`、`schedule` 是内部任务 scope，不从 chat 绑定来，也不进恢复索引。
