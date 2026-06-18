# Personal Context Agent 实施规划文档

> 本文档描述 **怎么做**(How)。产品需求见《需求文档》。
> 读者:实现者本人 + GPT 审查。所有命令使用 **pnpm**。

---

## 1. 技术栈

- Node.js 22+ / TypeScript / ESM
- **Agent 运行时**:`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`(curiosity 同款 fork)
- **结构化校验**:TypeBox(`typebox`,pi-ai 内置导出 `Type`/`Static`)
- **存储**:`better-sqlite3`(领域数据 + FTS5);会话 transcript 用 pi-agent-core 自带的 JSONL session 仓库
- **飞书**:`@larksuite/channel`(WebSocket 长连接,参考 lark-coding-agent-bridge)
- **定时**:`croner`(进程内调度)
- 不需要:Postgres / Redis / 向量库 / MCP server / 微服务

```bash
pnpm init
pnpm add @earendil-works/pi-agent-core @earendil-works/pi-ai better-sqlite3 @larksuite/channel croner
pnpm add -D typescript @types/node @types/better-sqlite3 tsx
```

---

## 2. 整体架构

```
飞书(私聊 / 日记群 / 主题群 / 通知群)
        │  @larksuite/channel  (WebSocket 长连接,出站)
        ▼
┌─────────────────────────────────────────────┐
│  常驻进程 (bot daemon)                         │
│                                               │
│  ┌── 飞书层 ────────────┐  ┌── 调度层 ─────┐   │
│  │ channel 连接          │  │ croner       │   │
│  │ 消息入队/防抖          │  │ 周总结 / 提醒 │   │
│  │ 命令路由              │  │ schedules 表 │   │
│  │ 卡片流式渲染          │  └──────────────┘   │
│  └──────────┬───────────┘                     │
│             ▼                                  │
│  ┌── Agent 层 ──────────────────────────────┐ │
│  │ 每个 chat scope 一个 AgentHarness          │ │
│  │ systemPrompt = soul + memory snapshot     │ │
│  │ tools: episode/memory/search/...          │ │
│  │ 流式事件 → 飞书卡片                          │ │
│  └──────────┬────────────────────────────────┘ │
│             ▼                                    │
│  ┌── Service 层 ────────────────────────────┐   │
│  │ DiaryService / MemoryService             │   │
│  │ ConsolidationService / RetrievalService  │   │
│  └──────────┬───────────────────────────────┘   │
│             ▼                                    │
│  SQLite (领域数据 + FTS5)  +  JSONL (会话 transcript) │
└─────────────────────────────────────────────────┘
```

---

## 3. pi-agent-core 使用方式(核心)

### 3.1 用 AgentHarness 而非裸 Agent

`@earendil-works/pi-agent-core` 导出两层 API:

- **裸 `Agent`**:有状态多轮对话体,自持 transcript;`prompt()` 反复调用追加;`subscribe()` 拿事件;`steer()`/`followUp()` 注入消息。
- **`AgentHarness`**:在 Agent 之上加了**会话持久化(Session + SessionRepo)、上下文压缩(`compact()`)、动态工具集(`setActiveTools()`/`setTools()`)、skills(`skill()`)、prompt 模板(`promptFromTemplate()`)**。

**结论:用 `AgentHarness`。** 会话持久化与 compaction 不用我们手写。

**导入路径(已核对 0.79.6 的 package exports,只有 `.` 和 `./node` 两个入口):**

```ts
import { AgentHarness, JsonlSessionRepo } from "@earendil-works/pi-agent-core";        // 顶层 re-export
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";                 // Node 执行环境
```

> ⚠️ 不要按 `@earendil-works/pi-agent-core/harness/agent-harness` 这类子路径导入——包没有暴露子路径 export,会解析失败。所有 harness 符号都从顶层入口拿。

**`AgentHarnessOptions` 已确认的必填/常用字段:**

```ts
const harness = new AgentHarness({
  env,                    // 必填:ExecutionEnv,用 NodeExecutionEnv
  session,                // 必填:Session(由 JsonlSessionRepo 创建/加载)
  model,                  // 必填:Model<any>(来自模型路由解析)
  tools,                  // 工具数组
  activeToolNames,        // 初始激活的工具名
  systemPrompt,           // string | (context) => string;注入记忆快照
  streamOptions,          // 流式/provider 选项
  getApiKeyAndHeaders,    // (model) => { apiKey, headers? }
});
```

可用方法(已核对):`prompt(text)`、`skill()`、`promptFromTemplate()`、`steer()`、`followUp()`、`nextTurn()`、`appendMessage()`、`compact()`、`setModel()`、`setTools()`/`setActiveTools()`、`subscribe(listener)`、`on(type, handler)`、`abort()`、`waitForIdle()`。**没有** `afterToolCall` 这类构造钩子(那是底层 `AgentLoopConfig` 的字段);harness 层一律用 `subscribe()` 的事件流 + `on()` 的拦截钩子。

### 3.2 流式回复 → 飞书卡片

`subscribe()` 收到的是 `AgentHarnessEvent = AgentEvent | AgentHarnessOwnEvent` 的合流。其中底层 `AgentEvent` 含:

- `message_update`(内含 `assistantMessageEvent.type === "text_delta"`)→ 取 `delta`,实时 `channel.stream` / `updateCardById` 更新飞书卡片。
- `tool_execution_start` / `tool_execution_end` → 卡片上渲染"正在写 episode…/已记住"。
- `turn_end`(带 `message` + `toolResults`)/ `message_end` → 收尾卡片。

参考 openclaw 的 `pi-embedded-subscribe.handlers.messages.ts` 与 lark-coding-agent-bridge 的 `card/run-renderer.ts`。

### 3.3 一次日记的处理流(对话 + 工具,不是 forced-submit)

```
日记消息进入日记群
  → 取/建该 scope 的 AgentHarness(systemPrompt 已注入记忆快照)
  → 存 raw diary(DiaryService)
  → harness.prompt(原文)
      → agent 流式吐 reply(text_delta → 卡片)
      → agent 调 write_episode 工具(落 episode)
      → agent 视情况调 upsert_working_item(低风险、可删;**不调 update_profile**)
  → turn_end 兜底:查"本条 diary_entry_id 是否已有成功落库的 episode",没有就补救
```

**为什么用 `turn_end` 而不是 `afterToolCall` 兜底**:`afterToolCall` 是底层钩子,且**一轮若完全没调工具就不会触发**——而我们恰恰要兜住"agent 没写 episode"的情况。`turn_end` 事件带本轮 `message` + `toolResults`,无论是否调过工具都会触发。

**兜底判据是"成功落库",不是"出现工具调用"**:`write_episode` 可能被调用却保存失败、返回 error、或没拿到 episode id。所以兜底条件是 **`SELECT 1 FROM episodes WHERE diary_entry_id = ?`**——查不到才补救。补救分两步:先 `harness.followUp(...)` 让模型重写;若仍失败,直接走 deterministic repair(用 companion 模型对原文做一次性 episode 抽取并落库),保证"每篇日记一条 episode"这个 v1 核心闭环不漏。实现上可顺带跟踪 `tool_execution_end` 的 `isError === false && details.id` 做快速判断,但**最终以 DB 查询为准**。

> 身份画像在日记轮里**不可写**(见需求 §4.2)。`update_profile` 只在周度合并与显式纠错命令里被调用。

### 3.4 工具定义(AgentTool)

```ts
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const EpisodeParams = Type.Object({
  brief: Type.String(),
  facts: Type.Array(Type.Object({ text: Type.String(), evidence: Type.String() })),
  emotions: Type.Array(/* ... intensity 1-5 ... */),
  thoughts: Type.Array(/* ... type/confidence/evidence ... */),
  blind_spots: Type.Array(/* ... */),
  actions: Type.Array(/* ... */),
  long_term_memory_candidates: Type.Array(/* type/content/confidence/reason */),
});

const writeEpisodeTool: AgentTool<typeof EpisodeParams> = {
  name: "write_episode",
  label: "写 Episode",
  description: "读完一篇日记后,把它蒸馏成结构化 episode 并落库。",
  parameters: EpisodeParams,
  execute: async (_id, params) => {
    const id = diaryService.saveEpisode(currentEntryId, params);
    return { content: [{ type: "text", text: `episode ${id} 已保存` }], details: { id } };
  },
};
```

v1 工具清单:

| 工具 | 作用 | 谁可调 | 阶段 |
|---|---|---|---|
| `write_episode` | 落一条结构化 episode | 日记轮 | v1 |
| `upsert_working_item` | 增改 project/open_loop(type/status/字段) | 日记轮 + 周合并 | v1 |
| `update_profile` | 改 prose 身份画像(add/replace/remove) | **仅周合并 / 显式纠错**,日记轮不可调 | v1 |
| `search_diary` | 对原文+episode 做 FTS 检索 | 任意 | v1 |
| `search_web` / `fetch_article` | 联网搜索 / 抓正文 | 任意 | 后续 |
| `write_lark_doc` | 写飞书云文档 | 任意 | 后续 |

`update_profile` 借鉴 Hermes 的子串匹配语义(`old_text` 唯一子串定位条目),配字符上限,写满报错逼合并;**每次成功写入都同步落一条 `profile_revisions` 审计**(旧值/新值/来源 ids/原因)。通过"日记轮不激活 `update_profile`"(`setActiveTools` 控制激活集)从机制上保证画像不被单篇日记污染。

---

## 4. Session 生命周期

**一个 chat scope 对应一个常驻 `AgentHarness` 实例**,放在内存 `Map<scopeId, HarnessEntry>`,持久化交给 SDK 的 Session 仓库。

### 4.1 记忆快照 = 冻结注入(Hermes 纪律)

- session 开始时,`MemoryService` 构建快照拼进 `systemPrompt`:`soul.md + memory_policy.md + response_style.md + 身份画像 + active 工作集 + 最近 N 篇 episode`。
- **整个 session 期间 systemPrompt 不变**(吃满 prefix cache)。
- session 内 agent 写的记忆**立即落 SQLite,但要到下个 session 重建快照时才出现在 prompt**——避免 agent 对自己刚写的记忆即时反应。
- `compact()` 是一个天然的快照刷新点(prefix cache 已断,顺便重新注入最新画像/工作集)。

### 4.2 各 chat 类型的会话策略

| Chat 类型 | 空闲超时 | compact 策略 | 重置 |
|---|---|---|---|
| 日记群 | 1 小时 | 兜底 autocompact(防失控) | 超时 / `/new` |
| 私聊 DM | 2 小时 | 兜底 autocompact | 超时 / `/new` |
| 主题群 | **无** | **上下文 85% autocompact** | 仅 `/new` / `/compact` |
| 通知群 | — | — | 无对话 |

- 跨天连续性**靠"最近 episode"层,不靠 transcript 堆历史**。所以日记群超时短,一次记日记 ≈ 一个 session。
- autocompact 用 SDK 的 `estimateContextTokens` / `shouldCompact` 判断,触发 `harness.compact()`。

---

## 5. 记忆系统实现

| 层 | 落地 | 注入方式 |
|---|---|---|
| ① 身份画像 | `profile` 表单条 prose | 直接进 systemPrompt |
| ② 工作集 | `working_items` 表(active) | active 条目格式化进 systemPrompt |
| ③ 最近 episode | `SELECT ... ORDER BY occurred_at DESC LIMIT N` | 进 systemPrompt |
| ④ 原文+episode 归档 | `diary_entries` / `episodes` + FTS5 | 不注入,`search_diary` 工具按需 |

**中文检索策略(实测过)**:FTS5 默认 `unicode61` tokenizer 对中文按整段切,`叶佳`/`项目`/`落地` 等查询全部 0 命中;故 FTS 表用 **`tokenize='trigram'`**。但 trigram 只覆盖 **3 字以上**片段,**1–2 字中文短词仍 0 命中**。所以 `search_diary` 的策略是:**查询 ≥3 字走 FTS(快、可回表),1–2 字走 `LIKE '%词%'` 兜底**(个人本地数据量下完全可接受)。两条路径都回表到 `diary_entry_id` / `episode_id`。

### 消化管线

- **每篇**:`write_episode` 工具落 episode(对话轮内,companion 模型)。日记轮的激活工具集**不含** `update_profile`。
- **每周日 23:55**:`ConsolidationService` 读本周 episodes →
  - 增量 `upsert_working_item`:active 项目/loop 的当前问题、下一步、决策据本周更新;长期不被提及的转 `dormant`。
  - 保守更新 `profile`:仅当本周出现稳定、跨篇复现的信号才动画像,且全量重写时以旧画像为基。**每次画像变更写一条 `profile_revisions`**(old/new + source_episode_ids/source_diary_ids + reason + run_id)。
  - 产出周总结发日记群。
  - 本周无 episode → 跳过。
- **显式纠错**:`/profile`、`/working` 只读查看;用自然语言纠正(如"把焦虑那条删了")时,画像改动同样走 `update_profile` + `profile_revisions`(reason=manual_correction)。
- **active/dormant 唤醒**:`search_diary` 命中归档中提及的 dormant 工作项时,可重新置 active 进入注入(检索回表见 §8 的 FTS 同步策略)。

---

## 6. 飞书交互层

参考 lark-coding-agent-bridge:

- `createLarkChannel({ appId, appSecret, domain })` + `channel.connect()`,WebSocket 出站长连接。
- `channel.on({ message, cardAction, error, reconnecting })` 监听。
- 消息进 `PendingQueue`(防抖,~600ms)再交 Agent 层。
- **建群**:`channel.createChat({ name, inviteUserIds })` 实现 `/new-diary-group`、`/new-chat`。
- **主动发消息**:`channel.send(chatId, {...})`(周总结、提醒、通知群转发)。
- **流式卡片**:`channel.stream(chatId, { card: { initial, producer } })` / `updateCardById`。
- **ChatRegistry**:`chat_registry` 表记 `chatId → chatType(diary/topic/notification/dm)`,消息入口据此分流到不同处理逻辑。
- **命令路由**:消息以 `/` 开头走命令处理器,否则走 Agent 对话。

单用户:仅 owner(`senderId`)可用,其余忽略。

---

## 7. 定时任务

进程内 `croner`,挂在常驻 bot 进程(进程为 WS 本就常活)。

| 任务 | 触发 | 实现 |
|---|---|---|
| 周度总结 + 合并 | 周日 23:55 | `ConsolidationService`(走 LLM,`weekly` 路由) |
| 记日记提醒 | 每天一次 | 查 `diary_entries` 最后时间,超 3 天发提醒(**纯代码,不走 LLM**) |
| 通用脚本(后续) | `schedules` 表配置 | runner 读表执行,结果转发通知群 |

`schedules` 表骨架 v1 就建好(`cron` 表达式 + 类型 + 目标 chat + 开关),但只填上述两条内置任务。AI 日报 / 知识卡片等具体脚本是更后面的内容。

---

## 8. 数据模型(SQLite)

会话 transcript 用 SDK 的 JSONL session 仓库(`data/sessions/`),**不入下列表**。领域数据:

```sql
-- 原文层(证据层,永不丢)
CREATE TABLE diary_entries (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  source TEXT NOT NULL,            -- lark / import
  input_type TEXT NOT NULL,        -- text / voice_transcript
  content TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  conversation_id TEXT,
  metadata_json TEXT NOT NULL
);
CREATE VIRTUAL TABLE diary_entries_fts USING fts5(content, content='diary_entries', content_rowid='rowid', tokenize='trigram');
-- 外部内容 FTS 必须用触发器同步,否则索引永远是空的;回表用 fts.rowid = diary_entries.rowid 取回 id
CREATE TRIGGER diary_ai AFTER INSERT ON diary_entries BEGIN
  INSERT INTO diary_entries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER diary_ad AFTER DELETE ON diary_entries BEGIN
  INSERT INTO diary_entries_fts(diary_entries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER diary_au AFTER UPDATE ON diary_entries BEGIN
  INSERT INTO diary_entries_fts(diary_entries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO diary_entries_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 单篇蒸馏
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  diary_entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  brief TEXT,
  analysis_json TEXT NOT NULL,     -- facts/emotions/thoughts/blind_spots/actions/ltm_candidates
  importance INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE episodes_fts USING fts5(brief, analysis_json, content='episodes', content_rowid='rowid', tokenize='trigram');
-- 同样用触发器同步;回表 fts.rowid = episodes.rowid → 取回 episode.id 与 diary_entry_id
CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, brief, analysis_json) VALUES (new.rowid, new.brief, new.analysis_json);
END;
CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, brief, analysis_json) VALUES('delete', old.rowid, old.brief, old.analysis_json);
END;
CREATE TRIGGER episodes_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, brief, analysis_json) VALUES('delete', old.rowid, old.brief, old.analysis_json);
  INSERT INTO episodes_fts(rowid, brief, analysis_json) VALUES (new.rowid, new.brief, new.analysis_json);
END;

-- ① 身份画像(单条 prose)
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 画像变更审计(每次 update_profile 落一条,保证可追溯)
CREATE TABLE profile_revisions (
  id TEXT PRIMARY KEY,
  old_content TEXT,
  new_content TEXT NOT NULL,
  source_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  source_diary_ids_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,            -- weekly_consolidation / manual_correction
  run_id TEXT,                     -- 关联 agent_runs / 周合并批次
  created_at TEXT NOT NULL
);

-- ② 工作集(project + open_loop 合一)
CREATE TABLE working_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- project / open_loop
  name TEXT NOT NULL,
  status TEXT NOT NULL,            -- active / dormant / done / dropped
  thesis TEXT,                     -- 项目主旨 / 问题描述
  current_questions_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  next_steps_json TEXT NOT NULL DEFAULT '[]',
  related_people_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_mentioned_at TEXT
);

-- 飞书 chat 注册
CREATE TABLE chat_registry (
  chat_id TEXT PRIMARY KEY,
  chat_type TEXT NOT NULL,         -- diary / topic / notification / dm
  name TEXT,
  created_at TEXT NOT NULL
);

-- 周总结存档
CREATE TABLE weekly_summaries (
  id TEXT PRIMARY KEY,
  week_key TEXT NOT NULL UNIQUE,   -- YYYY-W##
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 定时任务配置(骨架,v1 只填内置两条)
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  type TEXT NOT NULL,              -- weekly_summary / diary_reminder / script
  target_chat_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);

-- 审计
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  scope_id TEXT,
  command TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost REAL, latency_ms INTEGER,
  tool_calls_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
```

---

## 9. 模型配置(照搬 curiosity)

`data/llm-providers.json`:`providers → model_profiles → routes`。

```jsonc
{
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",   // curiosity 的 parser 强制 baseUrl 非空,必须给
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  },
  "model_profiles": {
    "companion": { "provider": "anthropic", "model": "claude-..." },
    "strong":    { "provider": "anthropic", "model": "claude-..." }
  },
  "routes": {
    "companion": "companion",   // 主对话 + episode 抽取(同一轮工具调用,同模型)
    "weekly": "strong"          // 周总结合并
  }
}
```

具体 provider/model 在导入前确定,不影响骨架。提醒任务不走模型。**Phase 0 加一个 config smoke**:加载 `data/llm-providers.json`,解析并 resolve `companion`、`weekly` 两条 route,确认 provider/baseUrl/model/apiKey 都拿得到。

---

## 10. 目录结构

```
PersonalAgent/
  agent/
    soul.md
    memory_policy.md
    response_style.md
  src/
    agent/        harness.ts, prompts.ts, tools/*.ts, schemas.ts
    lark/         channel.ts, cards.ts, commands.ts, chatRegistry.ts
    diary/        service.ts
    memory/       service.ts, consolidation.ts
    retrieval/    fts.ts
    schedule/     cron.ts, jobs.ts
    storage/      db.ts, schema.sql, migrations.ts
    config.ts
    main.ts       常驻进程入口
  data/
    app.db
    sessions/     SDK JSONL 会话
    llm-providers.json
  docs/
```

---

## 11. 分阶段实施

**v1 = Phase 0–3**;Phase 4–5 是 post-v1 roadmap,只在 schema/chat 类型上预留,不在本轮实现。

- **Phase 0 — 骨架**:pnpm 工程、TS、SQLite schema/migrations(含 FTS 触发器 + `trigram` tokenizer)、config(llm-providers)+ **config smoke**、`AgentHarness` 封装 + **harness smoke**(建 JSONL session、prompt 一轮、订阅 `message_update`/`tool_execution_*`/`turn_end`;含一例"`write_episode` 返回 error/不落库时兜底仍补写")、**中文 FTS smoke**(插一条中文日记,验证 `叶佳`(LIKE)、`项目落地`(FTS)都能返回 entry/episode id)、飞书 channel 连通(echo)。
- **Phase 1 — 日记群核心链路**:`ChatRegistry` + `/new-diary-group`;日记入库 → 流式回复 → `write_episode`(`turn_end` 兜底);记忆快照注入;流式卡片。**验证"它是不是比普通日记总结更懂我"。**
- **Phase 2 — 记忆消化与工作集**:`upsert_working_item`(日记轮 + 周合并)/ `update_profile`(仅周合并/纠错 + `profile_revisions`)/ `search_diary`(FTS 回表);周日 23:55 周总结 + 增量合并;active/dormant;每日提醒。
- **Phase 3 — 会话控制面 + 记忆纠错**:`/new`、`/compact`、`/profile`、`/working`(只读)+ 自然语言纠错;session 超时管理。
- **Phase 4(post-v1)— 主题群 + 讨论增强 + 写文档**:`/new-chat` 主题群(无超时 + 85% autocompact);`search_web` / `fetch_article`;`/write_doc` 写飞书云文档。
- **Phase 5(post-v1)— 通用定时调度 + 通知群**:`schedules` 表 runner + 通知群转发。
- **历史导入**:一次性脚本,作者在系统建成后自行执行(不在主线)。

---

## 12. 测试策略(遵循作者 CLAUDE.md)

只在高风险路径写测试,不为每个小改动补测试。重点覆盖:

- **记忆写入与消化**(数据写删 / 画像更新 / active-dormant 流转)——回归测试。
- **周度合并增量逻辑**(不丢工作集细节、画像不被短期事件带偏)。
- **session 生命周期**(超时重置、autocompact 触发、快照在下个 session 生效)。

不为私有 helper、流式渲染细节、理论不可达状态写测试。
