# 会话 Scope（Conversation Scopes）

> Post-MVP 北极星设计。定义各类聊天的会话生命周期、话题/主题群机制、以及"所有对话都喂记忆"的蒸馏规则。
> 依赖:`storage-architecture.md`(`messages`、`config.sessionPolicy`)、`knowledge-base.md`(反应/晋升)。

---

## 1. Chat 类型

| 类型 | 用途 | scope key |
|---|---|---|
| `diary` | 日记群:记日记、收周总结/提醒 | `chatId` |
| `dm` | 私聊:日常讨论、知识讨论、控制命令 | `chatId` |
| `topic` | 主题群(`/new-chat`):持续深聊 | `chatId` |
| `thread` | 话题(飞书原生 thread):临时深聊 | `chatId:threadId` |
| `notification` | 通知群:接收定时投喂(可捕获反应,不驻留对话) | — |
| `consolidation` | 内部 sub-agent(周总结/index),跑完即 reset | `<name>_<runId>` |

类型路由靠 `config.chatBindings`(群级)+ 消息的 `threadId`(话题级)。**不开 `resolveChatMode`**:`/new-chat` 群已记在 `chatBindings`、thread 靠 `threadId` 识别,`chatMode` 冗余且每 chat 多一次 `chat.get`。

---

## 2. 话题 vs 主题群:共用机制,不同生命周期

飞书原生"话题回复"(thread)和 `/new-chat` 主题群,**共用同一套 topic scope 机制**(无超时可配、autocompact、知识工具、边界蒸馏 episode),但**生命周期不同,不能合并**:

| | **话题 (thread)** | **主题群 (`/new-chat`)** |
|---|---|---|
| 触发 | 对某消息/卡片发"话题回复" | `/new-chat <主题>` |
| 容器 | 飞书原生 thread | 独立群 |
| scope key | `chatId:threadId` | `chatId` |
| 定位 | **极临时**,聊三五句就散 | **持续**,一两周泡在里面(如 AIGC 群) |
| 空闲超时 | **短** | **无** |
| episode 蒸馏 | 空闲关闭时 | 压缩 / `/new` 时 |

- HarnessManager 的 scope key 从 `chatId` 扩成支持 `chatId:threadId`(小改)。
- bot 用 `SendOptions.replyInThread: true` 把回复发回话题;`stream` 同样吃 `SendOptions`,流式卡片能在话题里跑。
- 话题/主题群都挂知识读类工具(`grep_vault`/`read_vault`),是知识被深度使用的主场。

---

## 3. sessionPolicy:可配置的自动关闭(对现状的变更)

### 3.1 现状

`HarnessManager.cleanupIdle(timeoutMs)` 是一个周期性扫描,**硬编码**:`topic` 跳过、其余用单一全局超时,且**只 delete 不蒸馏**。

### 3.2 目标

按 chatType 配置自动关闭,放 `config.json`:

```jsonc
"sessionPolicy": {
  "diary":  { "autoClose": true,  "idleMinutes": 60 },
  "dm":     { "autoClose": true,  "idleMinutes": 120 },
  "thread": { "autoClose": true,  "idleMinutes": 30 },
  "topic":  { "autoClose": false }
}
```

周期性扫描读这份配置:`autoClose:false` 跳过;其余按各自 `idleMinutes` 判断;**关闭前先触发 episode 蒸馏,再删 scope**。

> 关键:episode-on-close 必须靠**定时扫描(timer)**触发,不能"懒判定到下一条消息"——因为临时话题常常聊完就被丢弃、永远没有下一条消息。

---

## 4. 所有对话 scope 都在边界蒸馏 episode

实现"所有聊天内容都让 Agent 更懂我"——不止日记。

> **每个对话 scope 在边界事件蒸馏一条 episode:话题=空闲关闭;主题群=压缩 / `/new`;dm=空闲关闭。** 一个连贯片段收尾时蒸馏,**不每条消息蒸馏**。

- **日记**保留额外的"每篇一条"(它本就是离散单元;现状不变):episode 记 `source_message_id` = 那条日记消息,`source_scope_id` = 日记群,`source_started_at/source_ended_at` = 该消息时间。
- **DM / 话题 / 主题群** 现状不写 episode,本设计补上(边界蒸馏):episode 记 `source_scope_id` = 该会话 scope(`chatId` 或 `chatId:threadId`),`source_message_id` 为空,`source_started_at/source_ended_at` = 本次 scope 片段的首尾消息时间。要回查证据消息集时按 `source_scope_id + source_started_at/source_ended_at` 查 `messages`(来源模型见 `storage-architecture.md` §5.2)。
- **晋升与蒸馏解耦**(见 `knowledge-base.md` §5):普通回复一次性 → 晋升+蒸馏都当场;话题回复 → 晋升当场、蒸馏延到话题关闭,避免重复蒸馏。
- 红线:任何对话轮蒸馏的 episode/工作集**都不写身份画像**;画像只在周合并 / 显式纠错时动。

---

## 5. 通知群:捕获优先,深聊毕业到话题

通知群从 MVP 的"纯无对话"变成"**可捕获反应、但不驻留对话**"。**回复方式即深度选择器**:

- **普通回复**一张卡 → **快速反应**:晋升 Inbox→Garden + 当场蒸馏 episode + 一句轻确认(`💾 已收藏,并记下你的看法`)。该 episode 是单条消息锚点:`source_message_id` = 这条回复消息,`source_scope_id` = 通知群,时间窗等于回复消息时间。**不展开长对话**,否则通知群会被半截讨论塞爆、失去"攒着批量看"的定位。
- **话题回复**一张卡(飞书建 thread)→ **深聊**:thread 变成临时 topic scope(§2),用卡片知识(`messages.knowledge_path` → 读 vault 文件)+ 记忆快照做种子,bot 在话题里流式回应;结晶 → Garden。

---

## 6. reply 原文注入

消息带 `reply_to` 时,handler 查 `messages`(主键命中)把**直接父消息原文前置注入 prompt**(不做"获取 reply 原文"工具,理由见 `storage-architecture.md` §3.3)。

- 命中的 `messages` 行带 `knowledge_path` → 注入时多塞标记:`[这是对知识卡片的回应,原卡:<brief>,对应知识文件:<path>]`。Agent 据此知道这是知识反应(该晋升+蒸馏),想看全文就用现成 `read_vault` 读那个 path——**不需要任何 message-fetch 新工具**。

---

## 7. 记忆快照(承接现状)

- session 开始时构建快照拼进 `systemPrompt`,**整个 session 冻结**(吃 prefix cache);`compact()` 是天然刷新点。
- 快照含两块常驻摘要:**记忆摘要**(soul + policy + style + 画像 + active 工作集 + 近期 episode)+ **知识地图**(见 `knowledge-base.md` §7)。
- session 内写的记忆立即落库,但要到下个 session 重建快照才进 prompt(避免 Agent 对自己刚写的记忆即时反应)。
- 工作集 snapshot 渲染 ID、工具拆分等细节见 `working-item-tools-and-approval.md`。

---

## 8. 非目标

- 不合并话题与主题群(生命周期本质不同)。
- 不开 `resolveChatMode`。
- 不做跨 session 的暂停/恢复等待。
- episode 蒸馏不依赖"还有下一条消息"(靠定时扫描在关闭时触发)。
- 不把对话蒸馏写进身份画像。
