# 知识库重构：vault 极简化与收藏群入口

## 状态

需求定稿，待实现。

本文替代当前 `src/knowledge/vault.ts` 的 Inbox/Garden 二元设计、`.index.md` 常驻 system prompt 的知识地图机制，以及现有 `fetch_article` / `save_to_garden` / `grep_vault` / `update_frontmatter` / `promote` 工具集。

## 背景

参考 [claude-obsidian](/Users/caidongmeng/Documents/Github/ai/claude-obsidian) 的"自组织 wiki"思路重审现有知识库后，确认本项目核心定位是"老师视角更了解用户"，知识库只是加分项。现有知识库存在以下问题：

1. **Inbox/Garden 二元为 Obsidian PKM 用户设计**：要求用户主动 `promote` 动作，本项目用户实际不会执行——结果 Inbox 永久堆积，Garden 几乎空着。
2. **`.index.md` 常驻 system prompt**：每次 cron 重建都击穿 provider prefix cache；几十篇时是冗余，几千篇时也总结不完。
3. **`fetch_article` 抓取效果一般**：裸 HTML 标签清洗，质量低于 defuddle；飞书域名链接也走通用抓取，丢失结构。
4. **工具集冗余**：`save_to_garden` / `update_frontmatter` / `promote` 等都是 Inbox/Garden 模型的派生工具，跟 vault 真正需要的"读 / 写 / 抓"三件事不直接对应。
5. **收藏入口缺失**：用户只能通过 agent 主动调 `save_to_garden`，没有独立的"丢链接进群"低摩擦入口。

## 目标

- 砍掉 Inbox/Garden 二元、promote 概念、`.index.md` 常驻 prompt 机制。
- 新增独立"收藏群"入口（`LarkChatType: "clip"`），用户丢链接 → 后台抓取 + 子 agent 提炼 → 反馈卡 + 入库。
- 收藏群反馈卡支持"开话题继续聊这篇"——通过话题进入 agent 对话。
- 新增 `/save` 命令，把当前对话消化为可检索笔记。
- 工具集收敛为最小集：`vault_search` / `vault_read` / `fetch_article` / `vault_save`。
- 新增 `vault_digest` cron 替换 `knowledge_index`：兜底消化未处理的 clip，并刷新月度 `_overview.md`。
- 新增 `flash` 模型档位（默认 Haiku 4.5），用于 inline digest 等用户等待的子任务。
- vault 目录保持 markdown 兼容，**用户用 Obsidian 打开是只读窗口**——零成本副作用，所有设计决策不为 Obsidian 让步。

## 非目标

- 不做 `vault_research`：留待后续单独设计与实现。
- 不做双向链接 / 图谱 / lint / hot.md / 多级索引：claude-obsidian 投入最多工程的能力，对"老师"定位不必要。
- 不做 `vault_update` / `vault_delete`：用户改/删走 Obsidian 或 `rm`，agent 不替用户决定删什么。
- 不做近义词 tag 检测：词表膨胀靠手动治理 `vault_tags.json`。
- 不做收藏群多个 / 多 name：只支持唯一收藏群。
- 不做收藏群图片 / 文件 / 转发卡片支持：第一版只支持 URL（含可选评论）+ 纯文本。
- 不做 vault 数据迁移：当前 `Inbox/` / `Garden/` 内容直接删库，由用户手动清。
- 不为现有 `consolidation` 子 agent 同步引入 submit_tool 模式：可后续单独优化。

## 术语

| 术语 | 含义 |
|---|---|
| vault | 个人知识库根目录（`data/vault/`） |
| note | vault 内一篇 markdown 文件 |
| clip | 用户从收藏群丢入的素材 |
| digest | 把原始素材 / 对话压成结构化笔记的子 agent 任务 |
| inline digest | 用户/agent 同步等待的 digest（flash 档） |
| cron digest | `vault_digest` 兜底批量消化（normal 档） |
| source_type | note 的来源类型，枚举：`clip_digested` \| `conversation` \| `research` \| `manual` |
| flash | 新增模型档位，默认 Haiku 4.5，用于用户在等的子 agent 任务 |

## 目录与文件布局

```
data/vault/
├── notes/
│   └── YYYY-MM/
│       ├── _overview.md          # 当月 overview（cron 刷新；上月起冻结）
│       ├── <slug>.md             # 主笔记
│       └── <slug>.raw.md         # 仅 /save 对话存档，存过滤后原文
└── _meta/
    └── tags.json                 # 受限 tag 词表（gitignored）
```

- 平铺单层 `notes/`，**无** `concepts/` / `entities/` / `Inbox/` / `Garden/` 子目录。
- 月度子目录 `YYYY-MM` 对应文件 `saved_at` 月份。
- `_overview.md` 用 `_` 开头让 Obsidian 排序靠前。
- `.index.md` **完全废弃**，包括从 `data/vault/.index.md` 物理删除。

### Note frontmatter

```yaml
---
title: <子 agent 给>
domain: <子 agent 给，自由文本>
tags: [...]            # 子 agent 给，1-3 个
brief: <子 agent 给，≤140 字>
source_type: clip_digested | conversation | research | manual
source_url: ...        # 仅 URL 类有
origin_note: ...       # clip 路径=用户消息整条；/save 路径=用户附加备注；research 路径=用户问题
saved_at: <ISO>
processed_at: <ISO>    # 子 agent 提炼完成时间
raw_ref: <slug>.raw.md # 仅 conversation 类有，指向原文文件
---
```

`source_url` / `origin_note` / `raw_ref` 缺省即为缺。

### Note 正文结构

```markdown
<抓取或保存到的原始内容>

<!-- digest:start -->
---

## 提炼
- ...

## 我的备注
> ...（可选，由子 agent 判断是否输出）

## 摘录
> ...（可选）

<!-- digest:end -->
```

`<!-- digest:start --> ... <!-- digest:end -->` 注释包裹消化产物，便于重消化时剥掉旧块再追加新块。

### `<slug>.raw.md` 结构（仅对话存档）

```markdown
---
parent: <slug>.md
saved_at: <ISO>
---

# <title> · 原文

**用户**：...
**Agent**：...
**用户**：...
```

仅保留 `role=user.text` 和 `role=assistant.text`，丢弃所有 `tool_use` / `tool_result` / `thinking`。

## Tag 词表

文件：`data/vault/_meta/tags.json`（gitignored）

```jsonc
{
  "tags": [
    { "name": "技术", "seeded": true, "first_used_at": "..." },
    { "name": "工作", "seeded": true, "first_used_at": "..." },
    { "name": "RAG", "seeded": false, "first_used_at": "2026-06-29T..." }
  ]
}
```

- 启动时若文件不存在，写入预置种子（约 10-15 个粗类：技术/工具/AI/工作/健康/读书/关系/财务/...，最终词表由实现时决定）。
- **不读 `setting.json`**：`tags.json` 是唯一真相。
- 不做近义词检测；词表膨胀靠用户定期手动合并。

## 模型档位

`data/setting.example.json` 的 `model_profiles` 新增 `flash`，默认指向 `anthropic.claude-haiku-4-5-20251001`（具体 model id 实现时按 setting.example.json 风格写入）。

- `flash`：inline digest、收藏群入库
- `normal`：cron digest、`/save` 对话存档（取舍说明见下）、主对话默认
- `strong`：现有用法不变

**取舍**：`/save` 用户也在等，但对话原文通常比文章长且要求更高总结质量，先用 normal；若实测延迟过大再降级到 flash。

`DEFAULT_PROFILE` 保持 `normal`。

## 工具集

### 总览（4 个）

| 工具 | 用途 |
|---|---|
| `vault_search` | FTS 搜索 vault，支持空 query 取最近 N 条 |
| `vault_read` | 读 vault 一个文件全文 |
| `fetch_article` | 通用抓取：URL → markdown（feishu 域名走 SDK，其他走 defuddle）|
| `vault_save` | 写盘 + 去重 + tags 软校验。主 agent、digest 子 agent、`/save` 路径共用同一个工具 |

### `vault_search`

```ts
vault_search(query: string, k?: number = 10): Array<{
  title: string;
  brief: string;
  domain: string;
  tags: string[];
  source_type: string;
  saved_at: string;
  snippet: string;       // FTS snippet()，约 200 字
  path: string;
}>
```

- 走 SQLite FTS（沿用现有 retrieval 设施；表 schema 实现时确定）。
- `query` 为空字符串时返回按 `saved_at desc` 的最近 k 条（替代 `vault_recent`）。
- 综合相关度 + 时间新鲜度排序（实现可先纯 BM25，新鲜度作为 tiebreaker）。

### `vault_read`

```ts
vault_read(path: string): { frontmatter: object; body: string }
```

- 越界检查走现有 `VaultService.resolve`。
- 返回完整 body（包括 `<!-- digest -->` 块）。

### `fetch_article`

```ts
fetch_article(url: string): {
  title: string;
  body: string;          // markdown
  source_url: string;
  fetch_status: "ok" | "failed";
}
```

- Host 分流：
  - `*.feishu.cn` / `*.larksuite.com` → 飞书 docx SDK（`docx.v1.document.rawContent`，权限已在 scopes 中：`docx:document:readonly`）。
  - 其他 → `execFile("defuddle", ["parse", url, "-j"])`，解析 JSON 拿 `{title, content}`。
- 失败统一返回 `{title: url, body: "", fetch_status: "failed"}`，不抛错。
- 不入库、不调 LLM、无副作用——主 agent / digest 子 agent 都可调用做"抓来读"。
- 工具描述明确："抓到内容后**如果用户要求收藏**才调 `vault_save`，否则只用于阅读和回答"。

### `vault_save`

```ts
vault_save(args: {
  title: string;
  domain: string;
  tags: string[];                // 软校验：不在词表的当 new_tag 处理
  new_tags?: string[];           // 显式指定要新增的 tag
  brief: string;
  digest_markdown: string;       // 已是完整 markdown 段，宿主负责用 <!-- digest --> 包裹
  source_type: "clip_digested" | "conversation" | "research" | "manual";
  source_url?: string;
  origin_note?: string;
  raw_body?: string;             // 仅 conversation 路径用，写 <slug>.raw.md
}): {
  path: string;
  status: "saved" | "duplicate";
}
```

副作用：

1. **去重**：若 `source_url` 非空且 frontmatter 命中已有文件 → 返回 `{path: <已有>, status: "duplicate"}`，不写新文件。
2. **tag 软校验**：把 `tags` + `new_tags` 跟 `_meta/tags.json` 对比；不在词表的追加到词表，最终 frontmatter `tags` 字段是合并去重后的全集（数量上限按 schema 决定）。
3. **写文件**：路径 `notes/YYYY-MM/<slug>.md`，month 取 `saved_at` 当月。slug 由 `title` 经 `slugify` 生成；冲突走现有 `uniquePath`。
4. **正文组装**：抓到的原文（若 source_url 路径，从 fetch_article 返回的 body 来；conversation 路径不写原文这一段）+ `<!-- digest:start -->\n---\n{digest_markdown}\n<!-- digest:end -->`。
5. **重消化**：若文件已存在（非 duplicate 路径，比如 cron 重跑），先 strip 旧 `<!-- digest -->` 块再追加新块；frontmatter 字段覆盖。
6. **raw.md**：仅当 `raw_body` 非空时，同目录写 `<slug>.raw.md`，frontmatter 仅 `parent` + `saved_at`，body = `raw_body`。
7. **FTS 索引**：写入后同步更新 FTS 表。

### 砍掉的老工具

- `fetch_article`（旧实现）→ 重写
- `save_to_garden` → 砍
- `grep_vault` → 砍（被 `vault_search` 取代）
- `read_vault` → 重命名 `vault_read`
- `update_frontmatter` → 砍
- `promote` → 砍

## Digest 子 agent

### 调用场景

| 场景 | 工具集 | 模型档位 | 阻塞用户 |
|---|---|---|---|
| 收藏群 inline | `vault_save` 一个 | flash | 是（用户等反馈卡） |
| `/save` 对话存档 | `vault_save` 一个 | normal | 是 |
| `vault_digest` cron 兜底 | `vault_save` 一个 | normal | 否 |

三个场景共用同一个底层 harness 模式（ephemeral scope + scope reset），但 prompt 模板分两套：clip/research 用一套（输入是 URL + 原文 + origin_note），conversation 用一套（输入是过滤后的 messages + origin_note）。

### Prompt 草稿（clip / research）

```
你的任务是给一篇用户收藏到个人知识库的素材生成结构化元数据和提炼。

## 输入

- 用户的原始消息（可能包含指令如"帮我收藏"，也可能包含真实评论/视角）：
  <origin_note>{origin_note}</origin_note>

- 素材来源：
  <source_url>{url}</source_url>

- 素材正文（已抓取转 markdown）：
  <article>{body}</article>

## 当前可用 tags
{existing_tags_csv}

## 要求

1. title：用户能在 1 秒内识别这是什么的标题。原 title 是营销话术或截断时重写。中文优先。
2. domain：一级类目，自由文本（如"AI/机器学习"）。同类素材 domain 保持一致。
3. tags：1-3 个。从"当前可用 tags"挑。
4. new_tags：0-2 个。仅当素材属于稳定新主题且现有 tags 无近义词时新增。宁缺勿滥。
5. brief：≤140 字。一句话讲清楚素材内容和立场。不要"本文介绍了..."的废话开头。
6. digest_markdown：追加到文件正文末尾的 markdown：
   - `## 提炼` — 3-7 条要点
   - `## 我的备注` — **仅当** origin_note 含明确用户视角/评论/问题时输出。指令性内容（"帮我收藏"）忽略。
   - `## 摘录` — 可选，1-3 段最有信息密度的原文，用 `>` 引用

## 注意

- origin_note 可能完全是指令，此时不输出"我的备注" section。
- 素材抓取失败 / 内容残缺 / 登录墙时，brief 写"抓取内容不完整，仅记录链接"，digest_markdown 留空字符串。

调用 vault_save 提交结果，不要输出任何其他文本。
```

### Prompt 草稿（conversation）

```
你的任务是把一段用户跟 agent 的对话压成可检索的知识笔记。

## 输入

- 用户的额外备注（可能为空）：
  <origin_note>{note}</origin_note>

- 对话（已过滤工具调用，仅留双方文本）：
  <conversation>
  {filtered_messages}
  </conversation>

## 当前可用 tags
{existing_tags_csv}

## 要求

1. title：一句话点明这段对话的主题。
2. brief：≤140 字。这段对话讨论了什么、得出了什么结论或开放问题。
3. digest_markdown：
   - `## 结论` — 已得出的结论 / 决定 / 偏好
   - `## 要点` — 关键洞察、有用信息（来自任一方）
   - `## 原始证据`（可选）— 最关键的 1-3 句原话，用 `>` 引用并标注说话方
   - `## 后续`（可选）— 用户表达过的 TODO 或 open question
4. tags / new_tags / domain：同 clip digest 规则。

调用 vault_save 提交结果，不要输出任何其他文本。
```

### submit_tool 模式

- 子 agent 唯一工具就是 `vault_save`。
- 子 agent 调用 `vault_save` 即等于"我消化完了，提交结果"。
- pi-agent-core harness 在 tool_use 完成、tool_result 返回后，宿主侧观察到结束信号即 reset session。
- 主 agent 调用 `vault_save` 走同一份 execute，但不会被 reset——它是普通工具调用。

### 失败处理

| 失败 | 处理 |
|---|---|
| 子 agent 模型错误 / 工具调用格式错 | 子 agent harness 自身重试上限内吞掉，宿主拿不到 path → 反馈"消化失败"，不写文件 |
| `fetch_article` 返回 `fetch_status: "failed"` | 子 agent 仍调 `vault_save` 提交，brief 标记"抓取失败"，文件落但正文为空 |
| `vault_save` 命中 duplicate | 子 agent 路径里把 status=duplicate 视为成功路径——直接结束；调用方拿到 duplicate 后选择如何反馈 |

## 收藏群入口

### 类型与绑定

- `LarkChatType` 新增 `"clip"`：`type LarkChatType = "diary" | "topic" | "notification" | "dm" | "clip"`。
- 唯一收藏群（不支持多个 + name）。
- 绑定命令风格沿用 `/diary` / `/notification`，命名实现时定（候选 `/clip`）。

### 消息分流

```
收藏群消息进来
├─ msg.threadId 存在（话题内消息）
│   → 调 LLM 走话题对话路径，复用现有 handleTopicMessage
│   → 话题内消息进 messages 表
│
├─ msg.threadId 不存在 + msg.replyToMessageId 不存在（顶楼新消息）
│   → 走 ingest 流程（见下）
│   → 顶楼消息 **不进** messages 表
│
└─ msg.threadId 不存在 + msg.replyToMessageId 存在（直接回复卡片，未开话题）
    → 回引导文本"长按卡片可在话题里继续聊这篇"，不入库
```

### 顶楼 ingest 流程

```
T+0    收到顶楼消息（URL / URL+评论 / 纯文本）
T+0.x  贴表情回执 OnIt（飞书 reaction API）
T+?    抓正文：
         - 若用户消息含 URL（regex 提 URL）
         - host 命中 feishu.cn|larksuite.com → 飞书 docx SDK
         - 其他 host → defuddle
         - 纯文本（无 URL） → 跳过 fetch，body=用户消息原文
T+?    inline 跑 digest 子 agent（flash 档），输入：
         - origin_note = 用户消息整条
         - source_url = 提取出的 URL（纯文本路径为空）
         - article body = fetch_article 返回（纯文本路径为用户消息）
         - 当前 tag 词表
T+?    子 agent 调 vault_save 落盘
T+?    发反馈卡到群（带 knowledge_path 隐藏元数据）
```

**并发**：同一收藏群内 clip 串行处理。复用 `getOrCreateForMessageInLock` 类似的 per-chat lock 排队，保证"先发的先回卡"。

### 反馈卡

- 展示内容：
  - 标题：`✅ 已收藏`
  - 正文：`《<title>》` + `brief 第一句（≤120 字）`
  - 底部小灰字：`长按卡片可在话题里继续聊这篇`
- 隐藏元数据：
  - `knowledge_path = notes/YYYY-MM/<slug>.md`
  - `card_kind = "clip_feedback"`
- duplicate 路径：标题改 `📁 已收藏过`，正文显示原文件 title，不展示 path。
- 抓取失败路径：标题改 `⚠️ 抓取失败`，正文 `<url>` + `已记下原始链接，但内容抓不到`。

### 话题内对话

- 用户在反馈卡上点"话题回复"，飞书自动起 thread。
- thread 内消息走 `handleTopicMessage`。
- 话题根消息（即反馈卡）已在 messages 表里有 `knowledge_path` 元数据。
- 现有 `buildReplyContext` 已支持 `parent.knowledge_path`，自动注入 `这是对知识卡片的回应，对应知识文件：...`。
- agent 在话题里可以调 `vault_read(knowledge_path)` 读全文回答用户。

### 失败回执

| 失败 | 用户看到 |
|---|---|
| 抓取超时 | 反馈卡：`⚠️ 抓取失败，已记下链接` |
| digest 失败 | 反馈卡：`⚠️ 已收藏，但未能消化`，brief 用 url/title 兜底 |
| 表情回执 API 调用失败 | 静默吞掉，不阻塞主流程 |
| URL 重复 | 反馈卡：`📁 已收藏过`，附原 title |

## `/save` 命令

### 触发

- 用户在 DM / topic / clip-thread 内发 `/save` 或 `/save <备注>`。
- diary 群不支持（日记走 episode）。
- 收藏群顶楼不支持（顶楼消息不进 LLM）。

### 流程

```
T+0    收到 /save，解析可选备注
T+0.x  贴 OnIt 表情回执
T+?    取当前 active harness session 的全量 messages
       (无 last_save_message_id 状态——简单实现，重复 save 产生多个文件)
T+?    过滤：保留 role=user.text + role=assistant.text；丢 tool_use/tool_result/thinking
T+?    走 conversation digest 子 agent（normal 档）
T+?    子 agent 调 vault_save：
         - source_type = "conversation"
         - origin_note = 用户备注（可空）
         - raw_body = 过滤后原文 markdown
T+?    回一行短文本："已存档：《<title>》"，不发卡片
```

### 与 clip 笔记的关系

- `/save` 产物与 clip 笔记**不做显式关联**（即使 `/save` 发生在 clip-thread 里）。
- 若后续证明"找不到当时聊的文章"高频，再补 `related` frontmatter 字段。

### Slash 命令注册

- 接入 `src/lark/commands.ts` 现有 slash 命令机制（具体注册细节按现有约定）。

## `vault_digest` cron

替换现有 `knowledge_index` builtin schedule。

### 职责

1. 扫描 `vault/notes/` 下所有 frontmatter `source_type ∈ {clip, conversation, research, manual}` 但**缺 `processed_at`**或 `source_type === "clip"`（未消化标记）的笔记。
2. 对每篇调一次 digest 子 agent（normal 档），子 agent 调 `vault_save` 更新 frontmatter + 追加 digest 块。
3. 处理完后，按受影响的 month 分组，刷新每个月份的 `_overview.md`。

### `_overview.md` 生成

- 仅当月 `_overview.md` 持续被 cron 刷新；月份过去后**自动冻结**（cron 不再触达，除非该月有新文件被消化）。
- 内容由 cron 内一个轻量 prompt 生成（或本地 deterministic 模板拼接，二选一——实现时择一，倾向 deterministic 模板，本月 LLM 调用减一份）。
- 结构示例（模板版）：
  ```markdown
  ---
  generated_at: <ISO>
  month: 2026-06
  ---

  # 2026 年 6 月

  共 N 篇。

  ## 技术（M 篇）
  - 《<title>》：<brief 第一句> · <slug>.md
  - ...

  ## 工作（K 篇）
  ...

  ## tags 热度
  RAG (5), 长上下文 (3), ...
  ```
- 用户在 Obsidian 里打开月份目录，最上方就是 `_overview.md`。

### 不再做的事

- 不再写 `data/vault/.index.md`。
- 不再为 system prompt 提供知识地图。

### 触发频率

按现有 `schedules.json` builtin 配置（`config.ts:83` 附近）。frequency 实现时定，倾向每日一次。

## System prompt 调整

### `agent/prompts.ts` 改动

- `MemorySnapshot.knowledgeIndex` 字段删除。
- `buildMemorySnapshot` 不再读 `knowledgeIndexPath`。
- `buildSystemPrompt` 不再 push `---\n# 知识地图\n...` section。
- `filterVolatileMetadata` 函数删除（专为 `.index.md` 的 `updated_at` 行加的）。

### 新增 `agent/builtin/knowledge_policy.md`

- **仅 builtin，不支持 override**：在 `readPromptSet` 里用 `readBuiltinPrompt`，不走 `readOverridablePrompt`。
- 加载位置：跟 `memory_policy` 并列，在 `soul` 之后、画像之前。

内容主旨：

```
# 知识库

用户有一个外部知识库，存了从收藏群丢进来的资料、用 /save 保存的对话精华，以及让你做的调研产物。
你不在 system prompt 里看到库里有什么——查询要靠工具。

## 何时使用

主动查 vault 的触发条件是：用户当前的问题或谈话内容指向一个具体主题、一份具体材料，或一个他过去明显可能记录过的方向。例如：
- 用户问"我之前收藏过关于 X 的吗" → vault_search("X")
- 用户问"我刚收藏的那篇讲啥" → vault_search("") 取最近
- 用户聊到一个技术选型 / 方法论 / 人物 / 工具，且你不确定他过去是否有相关沉淀 → vault_search

## 何时不要使用

- 闲聊、日常陪伴、情绪话题——不要查
- 用户没问及具体主题、只在描述当下状态——不要查
- 一次回答里多次重复查询同一个关键词——不要

## 边界

vault 是被动工具：用户的问题或谈话指向具体主题时才查。不要为了找话题主动翻 vault，也不要在用户没问的情况下"提醒"他库里有什么。

## 引用

引用 vault 内容时，自然地说"你之前收藏的这篇..."或"你保存的那段对话里..."，不要暴露文件路径。

## 写入

- 用户让你"记一下当前对话"——告诉他直接发 /save 即可，你不要代调。
- 用户让你"抓某个链接看看" → fetch_article 抓来看，不一定要存。
- 用户明确要求"帮我收藏这个链接" → fetch_article 抓 + vault_save 入库。
- 不要不经用户明确请求就往 vault 写。

## 删除

vault 删除不在工具内：若用户要删笔记，告诉他在 Obsidian 里删或自己 rm。删除前必须先和用户口头确认要删的是哪一篇。
```

## 数据库 schema 改动

无新表。仅可能修改：

- FTS 表 schema 调整（若需要新增 source_type / tags 字段做 facet 过滤；实现时按 retrieval 现状决定，最小改动）。
- 现有 `messages` 表里**收藏群顶楼消息不写入**（实现层在 `handleClipMessage` 路径里跳过 `saveUserMessage`）。

## 配置改动

### `data/setting.example.json`

`model_profiles` 新增：

```json
"flash": {
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001"
}
```

### `data/vault_tags.json`（gitignored）

启动时检测：若不存在，写入预置种子。

### gitignore / CLAUDE.md 安全注释

`CLAUDE.md` 现有的 "Do not commit ..." 列表加上：
- `data/vault/_meta/tags.json`
- `data/vault/notes/`

`.gitignore` 同步。

`data/setting.example.json` 不变（不含 vault 路径）。

## 删除清单

实现完成后必须从代码 / 文件系统物理删除：

| 项 | 位置 |
|---|---|
| `Inbox/` 目录 | `data/vault/Inbox/`（用户手动 `rm -rf`，代码不留兼容） |
| `Garden/` 目录 | `data/vault/Garden/`（同上） |
| `.index.md` | `data/vault/.index.md` |
| `saveToGarden` 方法 | `src/knowledge/vault.ts` |
| `writeInbox` 方法 | 同上 |
| `promote` 方法 | 同上 |
| `buildDeterministicIndex` 方法 | 同上 |
| `writeKnowledgeIndex` 方法 | 同上 |
| `knowledgeIndexPath` const | `src/config.ts` |
| `runKnowledgeIndexBuiltin` 方法 | `src/agent/harness.ts:263` |
| `knowledge_index` chatType 分支 | `src/agent/harness.ts:544, 592` |
| `knowledge_index` builtin schedule 处理 | `src/schedule/cron.ts:154-` 等 |
| `knowledge_index` 类型成员 | `src/schedule/config.ts:23, 83` |
| `fetchArticle`（旧实现） | `src/knowledge/vault.ts:214-252` |
| `createFetchArticleTool`（旧实现） | `src/agent/tools/knowledge.ts` |
| `createSaveToGardenTool` | 同上 |
| `createGrepVaultTool` | 同上 |
| `createReadVaultTool`（保留语义但重命名为 `vault_read`） | 同上 |
| `createUpdateFrontmatterTool` | 同上 |
| `createPromoteTool` | 同上 |
| `promoteKnowledgeIfNeeded` | `src/lark/messageHandlers.ts:568` |
| `parent.knowledge_path` 相关 promote 调用 | `src/lark/messageHandlers.ts:488-513` |
| `MemorySnapshot.knowledgeIndex` 字段 | `src/agent/prompts.ts:68, 144` |
| 知识地图 section 拼装 | `src/agent/prompts.ts:201` |
| `filterVolatileMetadata` 函数 | `src/agent/prompts.ts:209-213` |
| `FetchArticleParams` / `SaveToGardenParams` / `GrepVaultParams` / `PromoteParams` / `UpdateFrontmatterParams` schemas | `src/agent/schemas.ts` |

不留兼容层、不留迁移层。

## 实现顺序

每一步 `pnpm build` 可验证：

1. **`flash` 档位**：`data/setting.example.json` 新增 profile，零代码改动。
2. **`VaultService` 重写**：砍掉 Inbox/Garden/promote/buildIndex；新增 `notes/YYYY-MM/` 路径计算、`source_type` 字段、`source_url` 去重查询、`<!-- digest -->` 块的剥离与追加。
3. **`tags.json` 读写**：服务化（读、追加、列举），软校验逻辑内嵌 `vault_save` 工具。
4. **`fetch_article` 重写**：飞书 docx SDK 分支 + defuddle 子进程；旧 `fetchArticle` 整段删除。
5. **`vault_save` 工具**：替代 save_to_garden 等老工具；与收藏群 ingest 共享底层 `ingestStructuredNote()` 函数。
6. **`vault_search` / `vault_read`**：FTS snippet 改造；`grep_vault` / `read_vault` 旧工具删除。
7. **`knowledge_policy.md`**：新建 builtin agent prompt 文件；`prompts.ts` 砍 `# 知识地图` section、删 `knowledgeIndex` 字段、删 `filterVolatileMetadata`。
8. **digest 子 agent 接入**：harness 内 ephemeral scope 模式，分 clip / conversation 两套 prompt 模板，共用 vault_save 工具。
9. **收藏群 `LarkChatType: "clip"`**：注册类型、绑定命令、消息分流、表情回执、反馈卡渲染、knowledge_path 元数据复用、话题对话复用 handleTopicMessage。
10. **`/save` slash 命令**：注册、过滤、调 conversation digest、回执。
11. **`vault_digest` cron**：替换 `knowledge_index` builtin；月度 `_overview.md` 生成。
12. **删旧代码 + `data/vault/` 物理清理**：按上述删除清单逐项。`Inbox/` / `Garden/` / `.index.md` 由用户 `rm` 手动清。

## 验证

实现完成后，下列场景应工作：

| 场景 | 期望行为 |
|---|---|
| 用户在收藏群发链接 | 表情回执 → 反馈卡（带 brief） |
| 用户在收藏群发链接 + 评论 | 反馈卡正常，提炼版 markdown 含 `## 我的备注` |
| 用户在收藏群发指令式消息 + 链接（"帮我收藏 ..."） | 提炼版 markdown **不含** `## 我的备注` |
| 用户在收藏群发纯文本 | 不调 fetch，文本本身作为正文，入库 |
| 用户在收藏群发已收藏过的 URL | 反馈卡显示"📁 已收藏过" |
| 用户在收藏群发抓不到的链接 | 反馈卡显示"⚠️ 抓取失败" |
| 用户在 DM 说"我之前收藏过 RAG 吗" | agent 调 `vault_search("RAG")` 回答 |
| 用户在 DM 说"我刚收藏的那篇" | agent 调 `vault_search("")` 取最近 |
| 用户在反馈卡上开话题问"这文章讲啥" | 话题内 agent 用 `vault_read(knowledge_path)` 读全文回答 |
| 用户在 DM 发 `/save` | 提炼版 + raw.md 双文件落盘，回"已存档：《...》" |
| 用户在 DM 发 `/save 这部分要重点记` | 同上，备注落 frontmatter `origin_note` |
| `vault_digest` cron 跑 | 处理未消化的 `source_type=clip`，刷月度 `_overview.md` |
| Obsidian 打开 `data/vault/` | 看到 `notes/YYYY-MM/_overview.md` + 笔记列表，能正常阅读 |
| 进程重启 / 长寿命 topic 会话 | system prompt 不再含知识地图，无破缓存风险（前次 design 的 prefix cache 不退化） |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| flash 档位下子 agent 把"帮我收藏"误识别为评论 | prompt 明确举例；上线后人工抽检 5-10 篇，必要时升级到 normal |
| tags.json 词表膨胀失控 | 接受第一阶段膨胀，每月扫一次手动合并；不引入工程化模糊匹配 |
| 飞书 docx SDK rawContent 返回格式不是 markdown | 实现时验证；若是 plain text/HTML，加一层转换或回退 defuddle |
| defuddle 子进程超时 / OOM | `execFile` 加超时，复用 `setting.json` 现有 `http.fetch.timeoutMs` |
| FTS 改造影响现有 retrieval | 实现时复用现有 retrieval 模块；新增 source_type / tags 字段做向后兼容 |
| 收藏群顶楼消息丢失（不进 messages 表） | 接受：原文已在 frontmatter `origin_note` 字段；FTS 搜得到 |
| 话题对话依赖反馈卡保存到 messages 表 | 验证 `saveAssistantMessage` 流程正确写入 `knowledge_path` |
| 月度 `_overview.md` 在月初空文件出现 | 接受：cron 第一次跑就会生成；用户在 Obsidian 偶尔看到空文件不严重 |

## 后续

- `vault_research`：单独 grill 后另起 design。
- `consolidation` 子 agent 转 submit_tool 模式：可选优化，不在本次范围。
- 跨项目 vault 引用：暂不考虑（项目是单用户单库）。
- vault 删除工具：等用户反馈"在 Obsidian 删太麻烦"再加。
