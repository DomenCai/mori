# 会话与冷却规则

Agent 对每个飞书 scope 维护一个独立对话上下文，并按 `config.json.sessionPolicy` 自动回收空闲 scope。这份文档讲清楚：什么时候算“接着上一轮聊”，什么时候算“开了个新会话”。

实现见 `src/agent/harness.ts`（`HarnessManager`）与 `src/main.ts` 的清理定时器；配置字段见 [配置参考](configuration.md)。

## 一句话规则

> 内存里还在 → 续；不在了 → 新开。

判断追加还是新建，唯一标准就是这个 scope 的会话条目此刻还在不在内存里。没有别的时间戳比较。

scope key 规则。scope key 就是 `IngestedMessage.conversationId`，是完整 scope，不再靠 `chat_id + thread_id` 现拼：

| 类型 | scope key |
|---|---|
| 日记群 / 私聊 / 主题群 | `lark:chat:<chat_id>` |
| 飞书话题 thread | `lark:thread:<chat_id>:<thread_id>` |
| 历史日记导入 | `import:diary:<date>`（按天一段，跨天 reset，见 [开发指南](development.md)） |
| 内部任务 | `weekly_consolidation` / `daily_memory_*` / `knowledge_index_*` 等内部 scope |

## 续聊 vs 新会话

入口是 `HarnessManager.getOrCreate(scopeId, chatType)`：

- **续聊（append）**：内存 `Map` 里查得到这个 `scopeId` → 复用现有 harness，只把最后活动时间刷新到当前，带着完整历史继续。
- **新会话（create）**：查不到 → 新建 harness，并开一个全新的 JSONL 会话文件。上一段历史不会带过来，相当于失忆重来。

每个会话条目记着一个 `lastActivityAt`。每收到一条消息就刷新它，这同时也是空闲倒计时的重置。

## 什么时候会变成新会话

会话条目从内存消失的三种途径，之后同一个 scope 的下一条消息都会触发新建：

| 途径 | 触发条件 | 说明 |
|---|---|---|
| 空闲关闭 | 满足 `sessionPolicy` 对应类型的 `idleMinutes` | 主要冷却机制；关闭前会先蒸馏需要收尾的 scope |
| 手动重置 | 发送 `/new` 命令 | 立即清掉当前 scope，下条消息从头开始 |
| 进程重启 | `stop` / 崩溃 / 升级重启 | 会话条目是纯内存的，重启后全部清空 |

## sessionPolicy

默认策略：

```jsonc
"sessionPolicy": {
  "diary":  { "autoClose": true,  "idleMinutes": 60 },
  "dm":     { "autoClose": true,  "idleMinutes": 120 },
  "thread": { "autoClose": true,  "idleMinutes": 30 },
  "topic":  { "autoClose": false }
}
```

后台每 5 分钟扫一遍所有会话条目，按对应策略判断是否关闭：

- `autoClose: false`：不自动关闭，只能靠 `/new`、`compact()` 或进程重启收束。
- `autoClose: true`：`当前时间 - lastActivityAt > idleMinutes` 时关闭。
- `thread` 用飞书 thread 独立 scope，默认 30 分钟空闲关闭。
- `topic` 是 `/new-chat` 创建的持续主题群，默认不自动关闭。

因为是 5 分钟一扫，实际关闭时刻会比刚满 `idleMinutes` 晚最多 5 分钟，这是预期行为。

## 关闭前蒸馏

`dm` / `thread` / `topic` 在关闭或 `/new` / `/compact` 前会先尝试把本段 scope 蒸馏成一条 episode：

- episode 来源是 `source_conversation_id + source_started_at/source_ended_at`。
- 只在本段消息里有用户消息时蒸馏。
- 若 LLM 写 episode 失败，会写一条 fallback episode，避免这段对话完全丢失。
- 日记群根消息仍按“每篇一条”写 episode，不靠关闭时蒸馏。

## 会话类型从哪来

收到消息时，先用 `ChatRegistry.getType(chatId)` 从 `config.json.chatBindings` 查群类型；私聊若未注册会自动登记为 `dm`。如果消息带 `threadId`，会优先作为 `thread` scope 处理。类型决定模型路由、工具集、是否按 `sessionPolicy` 自动关闭。

`consolidation`、`daily_memory`、`knowledge_index` 是内部任务 scope，不从 chat 绑定来。
