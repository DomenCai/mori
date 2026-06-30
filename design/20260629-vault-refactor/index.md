# 知识库重构：哑存储 + 智能消费者

## 状态

需求定稿，待实现。

本文替代当前 `src/knowledge/vault.ts` 的 Inbox/Garden 二元设计、`.index.md` 常驻 system prompt 的知识地图机制，以及现有 `fetch_article` / `save_to_garden` / `grep_vault` / `update_frontmatter` / `promote` 工具集。

## 背景

参考 [claude-obsidian](/Users/caidongmeng/Documents/Github/ai/claude-obsidian) 的"自组织 wiki"思路重审现有知识库后，确认两件事：

1. **本项目核心定位是"老师视角更了解用户"，知识库只是加分项。** 不为知识库引入重工程。
2. **claude-obsidian 的"自增长魔法"主要来自 prompt 纪律，不是算法。** 它约 6900 行代码里超过一半服务于"人在 Obsidian 里浏览"（canvas 图谱、hot.md、folds、CSS、Bases 看板）；它的混合检索（BM25+rerank，约 1300 行 + 本地 ollama）默认根本不开；它的"复用概念页连接新旧知识"完全靠 Claude 在 ingest prompt 里照做，没有独立算法。

现有知识库的真实问题：

1. **Inbox/Garden 二元 + promote 动作**：本项目用户不会执行 `promote`——结果 Inbox 永久堆积，Garden 几乎空着。
2. **`.index.md` 常驻 system prompt**：每次 cron 重建都击穿 provider prefix cache；几十篇时冗余，几千篇时也总结不完。
3. **`fetch_article` 抓取质量低**：裸 HTML 标签清洗，远不如 defuddle；飞书域名链接也走通用抓取，丢失结构。
4. **工具集冗余**：`save_to_garden` / `update_frontmatter` / `promote` 都是 Inbox/Garden 模型的派生。
5. **收藏是单向操作**：丢进去就再也不回看，"收藏=遗忘"。

## 核心原则：哑存储 + 智能消费者

这是整份设计的脊柱，所有取舍由它推导：

> **既然用户几乎不会回头浏览笔记、agent 是唯一的读者，那么知识库不需要"看起来有组织"，它只需要"查得到 + 能被综合"。而查得到和能被综合是消费时的属性，不是存储时的属性。**

所以：

- **写入侧是哑的**：收藏只做抓取 + 落盘，零 LLM、零结构化、零元数据加工。
- **智能全部在消费侧**，分两类消费者：
  - **查询时**（用户问到）：主 agent 用工具搜库、读原文、当场综合——只对真正被问到的主题花 token。
  - **定时**（收藏周报）：每周一次，把这一周的原文读一遍、综合成一篇值得读的周报推回飞书，并**把周报本身沉淀成笔记**，下周综合时读它做承接——这就是复利。

这比 claude-obsidian 的"写入时建概念页"更纯正地自增长：每丢一条都自动进入未来所有检索和周报，零合并动作、无结构可腐烂、永远拿当下全部相关笔记综合。

> 本设计建立在 [`20260629-agent-class-refactor`](../20260629-agent-class-refactor/index.md) 已落地的 agent 类化基础上：会话池/锁/恢复在 `src/agent/service.ts`（`AgentService`），会话装配在 `src/agent/harnessFactory.ts`，工具组装在 `src/agent/toolCatalog.ts`，agent 类放 `src/agent/agents/*.ts`，`OneShotAgent` 基类提供 `runForStream` / `runForFinalText` / `runForToolResult` / `runForSideEffect` helper。一次性 agent 通过 `AgentService.withOneShotAgent(agent, fn)` 调用。文中 manager 即 `AgentService`。

## 目标

- 砍掉 Inbox/Garden 二元、promote 概念、`.index.md` 常驻 prompt 机制。
- 新增独立"收藏群"入口（`LarkChatType: "clip"`）：丢链接 → 后台抓取 → **秒回反馈卡 + 入库**（写入侧零 LLM）。
- 反馈卡支持"开话题继续聊这篇"——通过话题进入 agent 对话。
- 新增 `/save` 命令，把当前对话过滤后存档为可检索笔记（写入侧零 LLM）。
- 工具集收敛为最小集：`vault_search` / `vault_read` / `fetch_article` / `vault_save`。
- 新增**收藏周报**：一个每周定时 agent（`WeeklyReviewAgent`），读本周新增笔记 + 上几期周报，综合成主题化周报，推送飞书卡 + **沉淀为 `source_type: review` 笔记**。它替换原 `KnowledgeIndexAgent` 与"知识地图"机制。
- 新增 `knowledge_policy.md`：写清 agent 何时搜库、如何跨多条综合、如何自然引用。
- vault 目录保持 markdown 兼容，**用户用 Obsidian 打开是只读窗口**——零成本副作用，所有设计决策不为 Obsidian 让步。

## 非目标

- **不做写入时 digest**：不在收藏入库时跑 LLM 加工 title/brief/tags/提炼。综合交给查询时和周报。
- **不做 SQLite FTS 表**：检索沿用现成的 `rg`（`VaultService.grep`），保持"markdown 文件是唯一权威源、零索引同步成本"。FTS 留作未来——当"库大了搜不准"成为实测痛点再加。
- **不做受限 tag 词表 / tags.json**：周报聚类是 agent 读时当场分的，不需要预标注。
- **不新增 `flash` 模型档位**：没有用户等待的 inline digest，无需新档位。
- 不做 `vault_research`：留待后续单独设计。
- 不做双向链接 / 图谱 / lint / canvas / 多级索引 / 方法论模式：claude-obsidian 投入最多工程、且服务于"人浏览"的能力，对"老师"定位不必要。
- 不做 `vault_update` / `vault_delete`：用户改/删走 Obsidian 或 `rm`，agent 不替用户决定删什么。
- 不做收藏群多个 / 多 name：只支持唯一收藏群。
- 不做收藏群图片 / 文件 / 转发卡片：第一版只支持 URL（含可选评论）+ 纯文本。
- 不做 vault 数据迁移：当前 `Inbox/` / `Garden/` 内容由用户手动 `rm`。

## 术语

| 术语 | 含义 |
|---|---|
| vault | 个人知识库根目录（`data/vault/`） |
| note | vault 内一篇 markdown 文件 |
| clip | 用户从收藏群丢入的素材 |
| review | 收藏周报沉淀成的笔记（`source_type: review`） |
| 查询时综合 | 用户问到时，主 agent 搜库 + 读原文 + 当场综合，跨多条连接 |
| 收藏周报 | 每周定时 agent 把本周新增综合成一篇并沉淀，对抗"收藏=遗忘" |

## 目录与文件布局

```
data/vault/
├── notes/
│   └── YYYY-MM/
│       └── <slug>.md          # clip / conversation / manual
└── reviews/
    └── YYYY-Www.md            # 收藏周报沉淀（每周一篇，按 ISO 周编号，幂等覆盖）
```

- 平铺，**无** `concepts/` / `entities/` / `Inbox/` / `Garden/` / `_meta/`。
- `notes/YYYY-MM/` 仅做轻量分桶（避免单目录文件过多），不为 Obsidian 排序服务。
- `reviews/` 独立目录，让周报 agent 能确定性地读"上几期周报"做承接，无需过滤。
- `.index.md`、`_overview.md`、`.raw.md`、`tags.json` **全部不存在**。

### Note frontmatter（极简）

```yaml
---
title: <抓取到的 title / 对话首句截断 / 周报标题>
source_type: clip | conversation | review | manual
source_url: ...        # 仅 clip 有
origin_note: ...       # clip=用户消息整条；conversation=/save 备注（可空）
saved_at: <ISO>
period: 2026-W26       # 仅 review 有
covers: [notes/...]    # 仅 review 有，本期周报覆盖的笔记路径
---
```

缺省字段即为缺。**没有 brief / domain / tags / digest / processed_at**——这些都是被删掉的写入时加工产物。

### Note 正文

正文 = 原始内容，无任何 `<!-- digest -->` 包裹块：

- **clip**：`fetch_article` 抓到的 markdown 正文（纯文本收藏则为用户消息原文）。
- **conversation**：过滤后的对话 markdown（仅 `role=user.text` + `role=assistant.text`，丢弃 `tool_use` / `tool_result` / `thinking`）。
- **review**：周报 agent 产出的综合正文。

## 工具集（4 个）

| 工具 | 用途 | 调 LLM | 副作用 |
|---|---|---|---|
| `fetch_article` | URL → markdown（feishu 走 SDK，其他走 defuddle） | 否 | 无 |
| `vault_save` | 新增写盘（append-only）+ URL 去重；对外 schema 无 `path`，不能覆写 | 否 | 写文件 |
| `vault_search` | rg 检索 vault，空 query 取最近 N 条 | 否 | 无 |
| `vault_read` | 读 vault 一个文件全文 | 否 | 无 |

四个工具全部无 LLM——它们是哑的原语，智能在调用它们的 agent 那一侧。

### `fetch_article`

```ts
fetch_article(url: string): {
  title: string;
  body: string;          // markdown
  source_url: string;
  fetch_status: "ok" | "failed";
}
```

- Host 分流：`*.feishu.cn` / `*.larksuite.com` → 飞书 docx SDK（`docx.v1.document.rawContent`，scope `docx:document:readonly` 已具备）；其他 → `execFile("defuddle", ["parse", url, "-j"])` 取 `{title, content}`。
- 失败统一返回 `{title: url, body: "", fetch_status: "failed"}`，不抛错。
- **不入库、无副作用**——主 agent / 周报 agent / 收藏群 host 都可调来"抓了读"。
- 工具描述明确："抓到内容后**仅当用户明确要求收藏**才调 `vault_save`，否则只用于阅读和回答。"

### `vault_save`

哑写盘 + URL 去重。**特权字段（`path` 覆写 / `period` / `covers` / `source_type=review`）不进对外工具 schema**——它们只属于内部 `ingestNote()`，由 host 直接调用。主 agent 拿到的是收窄 schema：只能新增笔记、不能覆写任意文件（把"不做 `vault_update`"落成 schema 层约束，而非靠注释自觉）。

内部函数 `ingestNote()`（host-only，全字段；供收藏群 host / `/save` host / 周报 host / 工具 execute 共用）：

```ts
ingestNote(args: {
  title: string;
  body: string;                  // 原始内容（抓取正文 / 过滤对话 / 周报综合）
  source_type: "clip" | "conversation" | "review" | "manual";
  source_url?: string;
  origin_note?: string;
  path?: string;                 // 显式路径幂等覆写：仅周报 host 写 reviews/YYYY-Www.md
  period?: string;               // 仅 review
  covers?: string[];             // 仅 review
}): { path: string; status: "saved" | "duplicate"; title: string }
```

对外工具 `vault_save`（主 agent 唯一调用者，收窄）：

```ts
vault_save(args: {
  title: string;
  body: string;
  source_type: "clip" | "manual";   // 不能写 review/conversation
  source_url?: string;
  origin_note?: string;
  // 没有 path / period / covers
}): { path: string; status: "saved" | "duplicate"; title: string }
```

工具 execute 内部转调 `ingestNote()` 且**恒不带 `path`**——主 agent 无从覆写既有文件。收藏群 / `/save` / 周报三个 host 都直接调 `ingestNote()`，不经工具。

副作用（`ingestNote`）：

1. **路径决策**：
   - `path` 显式给出（host-only）→ 原地覆写（幂等，周报重跑同一周不产生多份）。
   - `path` 省略 + `source_url` 非空且命中已有 → `{status: "duplicate", path: 命中文件路径, title: 命中文件 title}`，不写盘（返回 path 让"已收藏过"卡也能带 knowledge_path）。
   - 否则 → `title` slugify + `uniquePath` 落 `notes/YYYY-MM/`，返回 `saved`。
2. **URL 去重**：比较前做轻量 canonicalization——去 fragment（`#...`）、尾斜杠、`utm_*` 参数。不做内容相似度、不做跨 host 映射。
3. **frontmatter + 正文**：按上面 schema 写最小 frontmatter；正文直接是 `body`，**不包 digest 块、不写 brief/tags/domain**。

### `vault_search`

```ts
vault_search(query: string, k?: number = 10): Array<{
  title: string;
  source_type: string;
  saved_at: string;
  snippet: string;       // rg 命中行上下文，约 200 字
  path: string;
}>
```

- 沿用现有 `VaultService.grep`（ripgrep，`--fixed-strings`），扫整个 vault 根（含 `reviews/`——周报也是知识，应可被搜到）。
- `query` 为空 → 扫 frontmatter 按 `saved_at DESC` 取前 k（`listFrontmatter` 已有），覆盖"我刚收藏的那篇"。
- **不建 FTS 表**：markdown 文件是唯一权威源，rg 零索引同步成本。代价是无 BM25 排序——个人规模可接受，agent 可多关键词重试。

### `vault_read`

```ts
vault_read(path: string): { frontmatter: object; body: string }
```

越界检查走现有 `VaultService.resolve`，返回完整 body。

### 砍掉的老工具

`save_to_garden` / `update_frontmatter` / `promote` 砍；`grep_vault` → `vault_search`；`read_vault` → `vault_read`；`fetch_article` 重写。

## 收藏群入口

### 类型与绑定

- `LarkChatType` 新增 `"clip"`：`"diary" | "topic" | "notification" | "dm" | "clip"`。
- 唯一收藏群。绑定命令沿用 `/diary` / `/notification` 风格（候选 `/clip`，实现时定）。

### 消息分流

```
收藏群消息进来
├─ msg.threadId 存在（话题内）        → handleChatMessage（chatType=thread），进 messages 表
├─ 顶楼新消息（无 threadId/replyTo/rootId）→ 走 ingest（见下），顶楼消息不进 messages 表
└─ 其余（回复反馈卡但没开话题）        → 回引导文本"长按卡片可在话题里继续聊这篇"，不入库
```

### 顶楼 ingest 流程（单阶段、哑）

```
T+0    收到顶楼消息（URL / URL+评论 / 纯文本）
T+0.x  贴表情回执 OnIt
T+?    有 URL（regex 提取）：feishu host → 飞书 SDK；其他 → defuddle
       纯文本（无 URL）：跳过 fetch，body = 用户消息原文
T+?    ingestNote({
         title: fetch.title（失败/纯文本时 = url 或消息截断）,
         body: fetch.body（失败 = ""）,
         source_type: "clip",
         source_url: url（如有）,
         origin_note: 用户消息整条,
       })  → {path, status, title}
T+?    status=duplicate → 发"📁 已收藏过"卡（knowledge_path = 命中的原文件）。
       status=saved     → 发"✅ 已收藏"卡（含 title + 正文前 ~80 字确定性预览）。
T+?    saveAssistantMessage({ id: 卡 messageId, conversationId: 收藏群 conv,
         conversationType: <收藏群类型>, content: 卡正文, knowledgePath: path })
       ← 关键：反馈卡必须落 messages 表且带 knowledge_path。否则用户长按开话题后，
         buildReplyContext 按 replyTo??rootId 取父消息读不到 path，vault_read 这条主路径失效。
         范式同 cron.ts:376-383 的通知卡。
```

无第二阶段、无子 agent、无 flash——秒回。

**并发**：同一收藏群内 clip 串行处理，复用 `AgentService` 的 per-scope lock（按 chatId 锁队列，保证先发先回卡）。

### 反馈卡

- 成功：标题`✅ 已收藏`；正文`《<title>》` + 抓取正文前 ~80 字（**确定性截断，非 LLM 摘要**，抓取失败则省略）；底部小灰字`长按卡片可在话题里继续聊这篇`。
- duplicate：标题`📁 已收藏过`，正文显示原文件 title。
- 抓取失败：标题`⚠️ 抓取失败`，正文`<url>` + `已记下链接，但内容抓不到`（文件仍落盘，body 为空，origin_note 保留原始消息）。
- 隐藏元数据：`knowledge_path = notes/YYYY-MM/<slug>.md`，写在反馈卡对应的 assistant message 上（见上一步 `saveAssistantMessage`）。messages 表没有 `card_kind` 列，不为此新增——区分卡片类型靠 `knowledge_path` 是否存在即可（同 `handleNotificationMessage` 的判断）。

### 话题内对话

- 用户长按反馈卡 → 飞书起 thread → thread 内消息走 `handleChatMessage`（chatType=thread）。
- 话题根消息（反馈卡）的 `knowledge_path` 由 ingest 时的 `saveAssistantMessage` 写入；现有 `buildReplyContext`（`messageHandlers.ts:540`，按 `replyTo ?? rootId` 取父消息）自动注入`这是对知识卡片的回应，对应知识文件：...`。
- agent 在话题里调 `vault_read(knowledge_path)` 读全文回答。

## `/save` 命令

把当前对话过滤后存档，写入侧零 LLM。

### 触发与流程

- DM / topic / clip-thread 内发 `/save` 或 `/save <备注>`。diary 群不支持（走 episode）；收藏群顶楼不支持。
- 流程：贴 OnIt → 取**当前 session segment 窗口内**消息（`SessionRegistry` 的 `segment_started_at`→now，经 `getConversationMessages(conversationId, segment_started_at, now)`）→ 过滤为 `user.text` + `assistant.text` → 超过 60 条只留最近 60 条 → `ingestNote({title: 首条 user 消息首行截断（≤40 字）, body: 过滤后对话 markdown, source_type: "conversation", origin_note: 备注})` → 回一行`已存档：《<title>》`。
- **窗口取 segment 而非整段会话**：topic 不自动 close，整段会话可长达数周；segment 在蒸馏/reopen 时会被重置（`updateSegmentWindow`/`reopenWithExclusivity` 清窗口），所以 `/save` 存的是"上次蒸馏以来这一段"，边界清晰、不随会话寿命无限膨胀。60 条硬上限是兜底（超长时正文标注"（已存最近 60 条）"）。
- title 是确定性截断、非 LLM 生成。这段对话的"消化"交给查询时综合和周报。
- 无 `last_save_message_id` 状态：重复 `/save` 产生多个文件，可接受（segment 窗口 + 60 上限已把单次体量压住）。

### 与 clip 笔记的关系

不做显式关联（即使 `/save` 发生在 clip-thread 里）。若后续证明"找不到当时聊的文章"高频，再补 `related` 字段。

## 收藏周报（核心）

一个每周定时 agent，对抗"收藏=遗忘"，并通过沉淀实现复利。它**替换**原 `KnowledgeIndexAgent` + 知识地图 + 月度 overview。

### 类与生命周期

`AgentChatType` 把 `knowledge_index` 改名为 `review`：

```ts
export type AgentChatType =
  | "diary" | "dm" | "topic" | "thread"
  | "distill" | "consolidation"
  | "review"          // ← 原 knowledge_index 改名
  | "daily_memory"
  | "schedule";
```

新增 `src/agent/agents/weekly-review.ts`：

```ts
export class WeeklyReviewAgent extends OneShotAgent {
  readonly chatType = "review" as const;
  readonly scopeName = "weekly_review" as const;
  readonly defaultTools = ["vault_read"] as const;   // 可按需读单篇全文；不能改画像

  constructor(
    private readonly input: {
      weekItems: Array<{ path: string; title: string; source_type: string; excerpt: string }>;
      priorReviews: Array<{ period: string; body: string }>;  // 上 1-2 期周报，做承接
      period: string;                                          // 本期 ISO 周，如 2026-W26
    },
    ...deps
  ) { super(); }

  systemPrompt() { return () => buildSystemPrompt(buildMemorySnapshot(...)); }

  async run(): Promise<string | null> {
    return this.runForFinalText(buildWeeklyReviewPrompt(this.input));  // 返回综合正文
  }
}
```

周报产出是散文，用 `runForFinalText`（不是 submit_tool）。**沉淀由 host 做**：agent 只返回正文。

### cron 流程

替换现有 `knowledge_index` builtin，并把它从 **trigger 型改成普通 cron 型**——这是关键改造：现有 `knowledge_index` 不是 cron，而是 `initSchedules` 里一段 `setInterval` + volume trigger（按"新增 N 篇 / 隔 M 天"判断要不要跑，`cron.ts:154-177` + `shouldRunKnowledgeIndex`）。周报是固定每周一次，必须改成真正的 cron builtin：

- `src/schedule/config.ts`：`builtin` 枚举 `"knowledge_index"` → `"weekly_review"`；基线条目删 `trigger: {type:"volume",...}`，改 `cron: "0 8 * * 1"`（周一 08:00）。删 `KnowledgeIndexTrigger` 类型与 `BaseSchedule.trigger` 字段（仅它在用）。
- `src/schedule/cron.ts`：删 `initSchedules` 里整段 `knowledge_index` 的 `setInterval` 注册（`:154-177`）、`runKnowledgeIndexIfNeeded`/`shouldRunKnowledgeIndex`/`listMarkdownFiles`（`:579-608`）；`weekly_review` 走普通 `runBuiltin` 分支（`:231-238` 加 `else if (builtin==="weekly_review") await agentService.runWeeklyReviewBuiltin()`）。
- `src/config.ts`：删 `setting.knowledge.index`（含 `checkIntervalMs`，`:107-110` 的 `index` 子项，保留 `search`）。`AgentChatType` `"knowledge_index"` → `"review"`（`:57`）。
- `data/setting.example.json`：删 `knowledge.index` 段（`:82-85`，保留 `knowledge.search`）；`llm.model_profiles` 路由键 `"knowledge_index": "normal"`（`:41`）改名 `"review": "normal"`，否则改名后变僵尸键、周报路由不到档位（默认 normal）。
- `AgentService.runKnowledgeIndexBuiltin` → `runWeeklyReviewBuiltin`（仍走 `withOneShotAgent`）。

ISO 周计算现有工具不够（`utils.ts` 的 `businessDateKey` 只到天）：需加 `isoWeekKey(date) → "2026-W26"` 与 `isoWeekRange(period) → [周一 00:00, 下周一 00:00)` 两个小工具。

```
周一 08:00（cron "0 8 * * 1"）
T+0    missing = {有 ≥1 篇 saved_at∈该周、source_type≠review 的笔记，
                  且 isoWeekRange(该周).end ≤ now 的 ISO 周}   ← 只算已结束的周
                − {reviews/ 下已存在的 period}                 ← 凭文件存在性算缺口，不设滑动窗口
T+0    missing 为空 → 跳过
T+?    取 missing 里最旧的 ≤N 周（N=4），oldest→newest 逐周生成
       （旧的先做，让后一期能读到前一期做承接；超出 N 的更旧缺口留到下次，仍在 missing 不丢）：
         weekItems  = 扫 saved_at ∈ isoWeekRange(period) 且 source_type≠review，取 title + 前 500 字 excerpt
         priorReviews = reviews/ 下早于 period 的最近 1-2 期正文
         body = withOneShotAgent(new WeeklyReviewAgent({weekItems, priorReviews, period}), a=>a.run())
         body=null（agent 失败）→ 跳过该周（文件仍缺，下次重试），继续下一周
         ingestNote({ path:"reviews/<period>.md", title:"<period> 收藏周报", body,
                      source_type:"review", period, covers: weekItems.map(i=>i.path) })
T+?    只对本次生成的最新一期推飞书卡到通知群（复用 cron 的 `ensureNotificationChat` 默认通知目标，
       同 weekly_summary/daily_memory；更旧的补回只沉淀、不逐张轰炸）
       发送后 saveAssistantMessage({ id:卡 messageId, conversationType:"notification",
         content:卡正文, knowledgePath:"reviews/<最新 period>.md" })  ← 周报卡必须落表带 path，否则长按开话题读不到
```

> 缺口靠"有条目**且已结束**的 ISO 周 − 已生成的周"算、不设滑动窗口。两个边界都要管：① 必须把刚过去那周算进来（周一早跑时本周才刚开始、几乎没条目，只盯本周会漏掉刚结束那整周）；② 必须排除当前未结束的周（`isoWeekRange(period).end ≤ now`），否则周一 08:00 前的零星新收藏会把本周 review 提前生成、本周后续内容再也进不来。daemon 停多久恢复都能补齐欠周（每次最旧 ≤N，没补完下次继续，不丢周）；文件存在性即补偿/重试状态。

### 沉淀与复利

- 周报**写回 vault**（`reviews/<period>.md`，`source_type: review`），因此：
  - 它能被 `vault_search` 搜到——用户问"我那阵子在看啥"时，一篇周报常常是最佳命中。
  - 下一期周报读它做**承接**（"上周你在啃 X，这周继续深入了 Y"）——这就是 claude-obsidian `/fold` 的正确形态：在自然节奏（每周）、自然批次（这一周）、有真实触发（要发报）时才综合，而非每条入库都维护概念页。
- `covers` 让周报话题里的 agent 能顺藤摸瓜 `vault_read` 任一条原文。

### 周报卡与话题

- 一条卡=一条消息=一个话题。长按周报卡开话题→`handleChatMessage`（chatType=thread）。
- 周报卡的 `knowledge_path = reviews/<period>.md` 由上面发送后的 `saveAssistantMessage` 写入；话题里 agent 读这篇周报（含 `covers`），可继续 `vault_read` 单条深聊。
- 卡里列出本期条目**标题**（纯文本）。**不是每条一个独立 `knowledge_path`**——一条 assistant message 只有一个 `knowledge_path` 列，`buildReplyContext` 也只读父消息这一个；多条独立 path 进不了 thread 上下文。想单独深聊某条：在周报话题里直接说"展开讲讲 X 那条"，agent 凭周报的 `covers` `vault_read` 该条即可，不需要每条单独可点。
- （后续）若要"一键点开单条 → 直达该 clip 话题"，需为每条发独立卡/消息、或引入 card action 回调存 action context——第一版不做。

### Prompt 草稿（周报）

```
你在为用户生成过去这一周（{period}）的收藏周报，目的是把他这一周收藏却可能再没打开的东西，重新带回他面前。

## 这一周新增（title + 摘录）
{weekItems}

## 最近几期周报（用于承接，不要重复其内容）
{priorReviews}

## 要求
1. 不要做成清单——清单是又一个他不会读的东西。要主题化、有重点、有脉络。
2. 找出这一周的主线（"你这一周明显在啃 X"），把同主题的几条串起来讲清楚它们的关系/分歧。
3. 零散的一两条单独点一句即可。
4. 若与最近几期有延续（同一主题在深入），明确承接。
5. 自然口吻，像一个了解他的人在帮他回顾，不堆术语、不写"本周共收藏 N 篇"的报告腔。
6. 需要某条细节时可调 vault_read 读全文。

直接输出周报正文 markdown，不要输出任何额外说明。
```

## 查询时综合：`knowledge_policy.md`

claude-obsidian 真正出智能的地方是 query 侧的 SKILL 纪律。本项目把工程力气压在这一份 builtin prompt 上。

- **仅 builtin，不支持 override**：`readPromptSet` 里用 `readBuiltinPrompt`。
- 加载位置：跟 `memory_policy` 并列，`soul` 之后、画像之前。

内容主旨：

```
# 知识库

用户有一个外部知识库，存了收藏群丢进来的资料、用 /save 保存的对话精华、以及每周自动生成的收藏周报。
你在 system prompt 里看不到库里有什么——查询要靠工具。

## 何时查
- 用户问"我之前收藏过关于 X 的吗" → vault_search("X")
- 用户问"我刚收藏的那篇" → vault_search("") 取最近
- 用户聊到一个具体技术选型 / 方法论 / 人物 / 工具，且可能有过沉淀 → vault_search

## 何时不查
- 闲聊、陪伴、情绪话题——不查
- 用户没指向具体主题、只在描述当下状态——不查
- 同一关键词一次回答里反复查——不要

## 跨多条综合（重点）
搜到多条相关笔记时，不要只回一条。读相关的几条，把它们连起来：指出共识、分歧、时间线上的演变。
例如"你陆续收藏了三篇关于 X 的，早期那篇主张 A，最近这篇转向 B"。这是这个库越用越值钱的地方。

## 引用
自然地说"你之前收藏的这篇…""你保存的那段对话里…""上周的周报里提到…"，不要暴露文件路径。

## 写入
- 用户让你"记一下当前对话" → 告诉他直接发 /save，你不要代调。
- 用户让你"抓个链接看看" → fetch_article 抓来读，不一定要存。
- 用户明确"帮我收藏这个链接" → fetch_article + vault_save。
- 不经用户明确请求不要往 vault 写。

## 删除
删除不在工具内。用户要删，告诉他在 Obsidian 删或自己 rm，并先口头确认删哪一篇。
```

## System prompt 调整

`src/agent/prompts.ts`：

- 删 `MemorySnapshot.knowledgeIndex` 字段（`prompts.ts:68`）。
- `buildMemorySnapshot` 不再读 `knowledgeIndexPath`（`:144`）。
- `buildSystemPrompt` 不再 push `---\n# 知识地图\n...`（`:201`）。
- 删 `filterVolatileMetadata`（`:209`）。
- 新增加载 `knowledge_policy.md`（builtin，不可 override）。

## 配置与 schedule 改动

- **不新增档位**：周报跑 normal。但 `model_profiles` 路由有一个按 chatType 索引的键 `"knowledge_index": "normal"`（`setting.example.json:41`），改名后会变僵尸键——改成 `"review": "normal"`（`config.ts:57` 的 `AgentChatType` 同步改名）。
- `src/schedule/config.ts`：builtin 枚举与基线 `knowledge_index` → `weekly_review`；**从 trigger 型改 cron 型**——删 `trigger` 字段（基线 `:84`）、`KnowledgeIndexTrigger` 类型（`:54-58`）、`BaseSchedule.trigger`（`:18`），基线加 `cron: "0 8 * * 1"`。
- `src/schedule/cron.ts`：删 `knowledge_index` 的 `setInterval` 注册块（`:154-177`）与 `runKnowledgeIndexIfNeeded`/`shouldRunKnowledgeIndex`/`listMarkdownFiles`（`:579-608`）；`runBuiltin`（`:235`）加 `weekly_review` 分支。
- `src/config.ts`：删 `knowledge.index`（`:107-110` 的 `index` 子项，保留 `search`）。
- `data/setting.example.json`：删 `knowledge.index` 段（`:82-85`，保留 `knowledge.search`）。
- `src/utils.ts`：加 `isoWeekKey(date)` / `isoWeekRange(period)`（现有 `businessDateKey` 只到天）。
- `CLAUDE.md` "Do not commit" 列表 + `.gitignore` 加 `data/vault/notes/`、`data/vault/reviews/`。

## 删除清单

物理删除，不留兼容/迁移层：

| 项 | 位置 |
|---|---|
| `saveToGarden` / `writeInbox` / `promote` / `buildDeterministicIndex` / `writeKnowledgeIndex` | `src/knowledge/vault.ts` |
| `knowledgeIndexPath` const | `src/config.ts` |
| `KnowledgeIndexAgent` 整文件 | `src/agent/agents/knowledge-index.ts` → 由 `weekly-review.ts` 取代 |
| `AgentChatType` 的 `knowledge_index` | `src/config.ts:57` → `review` |
| `runKnowledgeIndexBuiltin` | `src/agent/service.ts:320` → `runWeeklyReviewBuiltin`（走 `withOneShotAgent`） |
| `knowledge_index` 的 trigger/interval 整条路径 | `src/schedule/cron.ts`：`setInterval` 注册块 `:154-177` + `runKnowledgeIndexIfNeeded`/`shouldRunKnowledgeIndex`/`listMarkdownFiles` `:579-608` 全删；`runBuiltin` `:235` 分支改 `weekly_review` → `runWeeklyReviewBuiltin` |
| `KnowledgeIndexTrigger` 类型 + `BaseSchedule.trigger` + 基线 `trigger` | `src/schedule/config.ts:18,54-58,84`（基线改 `cron: "0 8 * * 1"`） |
| `knowledge.index`（`checkIntervalMs`）配置 | `src/config.ts:107-110`（删 `index` 子项保留 `search`）+ `data/setting.example.json:82-85`；profile 路由键 `knowledge_index`→`review`（`setting.example.json:41`） |
| `knowledge_index` builtin 枚举 | `src/schedule/config.ts:23,83` → `weekly_review` |
| 旧 `fetchArticle` | `src/knowledge/vault.ts:214-252` → 重写（defuddle / 飞书 SDK）|
| `createFetchArticleTool`（旧）/ `createSaveToGardenTool` / `createGrepVaultTool` / `createReadVaultTool` / `createUpdateFrontmatterTool` / `createPromoteTool` | `src/agent/tools/knowledge.ts` → 重写为 `fetch_article` / `vault_save` / `vault_search` / `vault_read` |
| 老 vault 工具在 `toolCatalog.ts` 的注册 | `src/agent/toolCatalog.ts` → 换 4 件套 |
| `promoteKnowledgeIfNeeded` + 调用 | `src/lark/messageHandlers.ts:344,488-513,568` → 删 promote 逻辑，**保留** `knowledge_path` 隐藏元数据与 `buildReplyContext` 注入 |
| `MemorySnapshot.knowledgeIndex` / 知识地图 section / `filterVolatileMetadata` | `src/agent/prompts.ts:68,144,201,209` |
| `FetchArticleParams` / `SaveToGardenParams` / `GrepVaultParams` / `ReadVaultParams` / `UpdateFrontmatterParams` / `PromoteParams` | `src/agent/schemas.ts:132-178` → 换 `VaultSaveParams` / `VaultSearchParams` / `VaultReadParams` / `FetchArticleParams`(新) |

**用户数据**（不在代码改动范围）：`data/vault/Inbox/`、`Garden/`、`.index.md` 留在磁盘无害（新代码读不到）；用户自行 `rm`。实现者不写删用户文件的脚本。

## 实现顺序

每步 `pnpm build` 可验证：

1. **`AgentChatType` 改名** `knowledge_index` → `review`；连带 `service.ts` / `schedule/config.ts` / `schedule/cron.ts` 分支改名；删 `knowledge-index.ts`。
2. **`VaultService` 重写**：砍 Inbox/Garden/promote/buildIndex/writeIndex；新增 `notes/YYYY-MM/` 与 `reviews/` 路径计算、`ingestNote()`（含 URL canonicalization 去重、显式 path 幂等覆盖）、`listFrontmatter` 排序取最近、`grep` 适配结构化返回。
3. **`fetch_article` 重写**：飞书 SDK + defuddle 子进程；`execFile` 加超时（复用 `setting.json` `http.fetch.timeoutMs`）。
4. **4 工具**：`vault_save` / `vault_search` / `vault_read` / `fetch_article`，`toolCatalog.ts` 换注册；`schemas.ts` 换 schema。
5. **`knowledge_policy.md`** + `prompts.ts` 砍知识地图 / `knowledgeIndex` / `filterVolatileMetadata`。
6. **收藏群 `LarkChatType: "clip"`**：注册、绑定命令、消息分流、表情回执、哑 ingest、反馈卡（含确定性预览）、**发卡后 `saveAssistantMessage(knowledgePath=notes/...)`**（长按开话题深聊的前提）、话题复用 thread 路径。
7. **`/save`**：注册、按 session segment 窗口 + 60 条上限取数、过滤、`ingestNote(source_type=conversation)`、回执。
8. **`WeeklyReviewAgent` + cron**：`weekly-review.ts`、`runWeeklyReviewBuiltin`；schedule **从 trigger 型改 cron 型**（删 `setInterval`/`trigger`/`checkIntervalMs`，基线 `cron:"0 8 * * 1"`）；加 `isoWeekKey`/`isoWeekRange`；缺口 = 有条目**且已结束**（`isoWeekRange(period).end ≤ now`）的 ISO 周 − 已生成的 period，每次补最旧 ≤4 周（oldest→newest 保承接，幂等，漏跑自动补不丢周）；每周 `runForFinalText` → 沉淀 `reviews/<period>.md`；只对最新一期推卡并 `saveAssistantMessage(knowledgePath=reviews/<period>.md)`，条目标题纯文本列表。
9. **代码清理**：按删除清单逐项；旧用户目录留给用户 `rm`。

## 验证

| 场景 | 期望 |
|---|---|
| 收藏群发链接 | 表情回执 → 秒回反馈卡（title + 确定性预览），无 LLM 等待 |
| 收藏群发链接 + 评论 | 入库，origin_note 存整条消息 |
| 收藏群发纯文本 | 不调 fetch，文本作正文入库 |
| 收藏群发已收藏 URL | 卡显示"📁 已收藏过" |
| 收藏群发抓不到的链接 | 卡显示"⚠️ 抓取失败"，文件仍落盘 |
| DM 问"我之前收藏过 RAG 吗" | agent `vault_search("RAG")` 回答 |
| DM 问"我刚收藏的那篇" | agent `vault_search("")` 取最近 |
| DM 问"我收藏的关于 X 的几篇有啥关系" | agent 读多条、**跨条综合**指出共识/分歧/演变 |
| 反馈卡开话题"这文章讲啥" | 话题内 `vault_read(knowledge_path)` 读全文回答（依赖发卡时已 `saveAssistantMessage` 把 `knowledge_path` 落表） |
| 收藏后长按反馈卡再回复 | `buildReplyContext` 按 `replyTo??rootId` 取到父卡、读出 `knowledge_path` 注入 prompt |
| DM 发 `/save` / `/save 备注` | 取 session segment 窗口（≤60 条）过滤落 `source_type=conversation`，回"已存档：《…》" |
| 长会话（topic 数周不 close）发 `/save` | 只存 segment 窗口内、最多最近 60 条，不会存出超大笔记 |
| 周报 cron 跑（上一周有新增） | 推主题化周报卡 + 条目标题列表；沉淀 `reviews/<period>.md`（`source_type=review` + `covers`）；周报卡落表带 `knowledge_path` |
| 周报 cron 跑（上一周无新增） | 跳过，不发空卡 |
| daemon 停数周后恢复 | 下次 cron 按"有条目的周 − 已生成的周"补齐欠的周（每次最旧 ≤4 周，没补完的下次继续，不丢周）；只对最新一期推卡 |
| 周一早上跑周报 | 缺口锚定已结束 ISO 周，不会因本周才刚开始而漏掉刚过去那周 |
| 周一 08:00 前本周已有零星新收藏 | 当前未结束周被 `end ≤ now` 过滤掉，不会被提前生成 review；本周内容留到下周一才入周报 |
| 多条目周报想深聊某一条 | 周报话题里 agent 凭 `covers` `vault_read` 该条（卡不为每条挂独立 path） |
| 连续两周都有收藏 | 第二周周报**承接**第一周（读到上期 review） |
| 用户问"那阵子我在看啥" | `vault_search` 命中某期周报，agent 据此回答 |
| Obsidian 打开 vault | 看到 `notes/` + `reviews/` 可正常只读阅读 |
| 长寿命 topic 会话 | system prompt 不含知识地图，prefix cache 不退化 |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| rg 检索对中文语义/近义召回弱 | 个人规模可接受；agent 可多关键词重试；真成痛点再引入 FTS（markdown 仍是权威源，FTS 只作可重建索引） |
| 周报综合质量不足以"勾回"用户 | prompt 强调主题化叙事、禁清单；上线后人工看几期，必要时升 strong 档 |
| 周报读全周原文超 context（爆量周） | 默认只喂 title + 500 字摘录；agent 按需 vault_read；必要时 map-reduce |
| 飞书 docx SDK rawContent 非 markdown | 实现时验证；若 plain/HTML，加转换或回退 defuddle |
| defuddle 子进程超时 / OOM | `execFile` 加超时，复用 `http.fetch.timeoutMs` |
| 用户在 Obsidian 手改文件 | 无 FTS 索引可偏离，rg 实时扫文件，天然一致 |
| 收藏群顶楼消息不进 messages 表 | 接受：原文在 frontmatter `origin_note` + 正文，rg 搜得到 |
| `/save` 重复产生多文件 | 接受第一版；segment 窗口 + 60 条上限已压住单次体量与重叠，高频再加 `last_save_message_id` |

## 后续

- FTS：检索质量成为实测痛点时再加（独立表 `vault_notes_fts`，trigram，参考 `episodes_fts`；vault_save 内同步 upsert）。
- 写入时 digest：当"用户查询极频繁、每次重读原文太慢"成为实测痛点时再加。
- `vault_research`：单独 grill 后另起 design。
- 月报 / 季报"best of"：周报跑顺后，同一沉淀机制可扩展到更长周期。
- 跨项目 vault 引用：单用户单库，暂不考虑。
