# 存储架构（Storage Architecture）

> Post-MVP 北极星设计。本文定义"什么数据放在哪里"的统一判据,是其余三份设计文档的地基。
> 现有 MVP 代码为基线;本文凡涉及改动均显式标注"对现状的变更"。

---

## 1. 统一原则:可变即结构化,正文一次写定

> **可变的数据必须是结构化的;自由正文一次写定、永不就地回改。**

- **结构化数据(JSON / YAML frontmatter)** → 可更新,更新方式是**整体覆盖/重写**,没有"diff 第几行对不上"的就地编辑难题。
- **自由正文(文章正文、日记原文、周总结文本)** → **写入即冻结**,Agent 永不修改正文。

这条原则消除了"对长文本做就地编辑"这一整类 bug,是后面所有取舍的总纲。它在工具层被物理锁死:**写类工具只提供「建文件 / 改 frontmatter / 移动文件」,不提供「编辑正文」**(见 `knowledge-base.md`)。

---

## 2. 三层存储判据

| 层 | 放哪 | 判据 | 谁来读 |
|---|---|---|---|
| **vault 文件(markdown + frontmatter)** | 人要浏览/编辑/ripgrep 的正文 + episode 锚点 | 持久、要人读、要 grep | 人 + Agent(grep) |
| **`messages`(基建日志,SQLite)** | **所有**聊天原始正文,不分业务,按 message_id 索引 | 需 reply 解析、完整传输记录 | 机器,不浏览 |
| **其余 SQLite 表** | 结构化记忆 / 配置以外的热数据 | 需 FTS / 跨表关联 / 高频原子 upsert | 机器,热查询 |
| **`config.json`(JSON 配置)** | 人要直接看/改的结构化配置 | 整体覆盖、无 FTS、无 join、低频写 | 人 + 机器 |

**关键豁免规则**:正文类数据原则上进 vault,但若它需要"跨表 join / 外键关联",可留在结构化层。

**判据自检**:某数据要不要进 SQLite?——问它是否需要 FTS、跨表 join、或高频原子并发写。是 → DB;否,且人能从中受益于直接读改 → 文件(vault 或 config.json)。

---

## 3. `messages` 基建表(新增)

### 3.1 动机

飞书的 `reply_to` 可以指向任意久远的历史消息,而:

- SDK 的 JSONL transcript 是按 session 存的,`compact()` 会有损压掉旧轮次,且不按 message_id 索引。
- 典型场景:通知群里一堆卡片攒着,我**几天后**批量看、挑一条发"话题回复",那条原始卡片早已不在任何活跃 session 里。

所以必须有一张**按飞书 message_id 索引、不受 compact 影响、持久**的消息表。

### 3.2 定位:纯基建,不认识业务

`messages` 是基建层,**DB 不该认识上层业务**。它无差别存下**所有**聊天原始正文(日记、DM、主题群、话题、通知卡片回复),不区分"这是不是日记"。这样上层业务改动不会波及存储层。

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,            -- 飞书 message_id
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- user / assistant
  content TEXT NOT NULL,          -- 原始正文（含日记原文）
  reply_to TEXT,                  -- 被回复的 message_id
  thread_id TEXT,                 -- 话题（thread）id，普通消息为空
  root_id TEXT,                   -- 话题根消息 id
  knowledge_path TEXT,            -- 仅推送的知识卡片：指向 Inbox 里的 .md
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
```

规则:

- **双向都存**:我发的(role=user)+ Agent 回的(role=assistant)。
- **不存工具调用**:工具调用没有 message_id、不可被 reply,无意义。
- **`knowledge_path`**:推送知识卡片时由框架写入,使 `reply_to` 命中后**一次查表**即可判定"这是对某张知识卡的反应"(见 `knowledge-base.md` 反馈回路)。

### 3.3 reply 原文:注入,不做工具

`reply_to` 命中时,handler 查一次 `messages`(主键命中),把原文**前置拼进 prompt**——而不是给 Agent 一个"获取 reply 原文"的工具。理由:reply 这个动作的定义就是"我在回应那条原文",原文几乎 100% 是必需上下文,凡"几乎总是需要"的东西就不该让 Agent 多一轮 tool call 去取。深链回溯是假想需求,只注入直接父消息一层。详见 `conversation-scopes.md`。

---

## 4. vault 目录布局

vault 是 **Agent 自己拥有**的一个目录(就是一个 Obsidian 仓库,你随时能打开读改),但它就是知识库的**真相源**,不是"外部 Obsidian 的镜像"。

```
vault/
  Inbox/
    <任务名>/            # 每个定时 script 任务手动指定写到哪个子目录
      2026-06/          # 按月子目录，写入时框架负责确保该月目录存在
        <slug>.md
  Garden/
    2026-06/            # Garden 同样按月子目录
      <slug>.md
```

- **没有 `Diary/` 目录**:日记原文只存在 `messages`(见 §5),不在 vault。vault 只装"会被浏览/双链/深挖的知识",不装语音转写流水。
- frontmatter 约定见 `knowledge-base.md`。

---

## 5. 日记存储重构(对现状的变更)

### 5.1 现状

MVP 把日记原文存在 `diary_entries` 表(带 `diary_entries_fts` trigram FTS + 三个同步触发器),`episodes.diary_entry_id` 外键指向它。

### 5.2 目标

- **删除 `diary_entries` 表 + `diary_entries_fts` + 三个触发器。**
- 日记原文**只进 `messages`**(role=user,在日记群 chat)。
- `episodes` 的锚点字段 `diary_entry_id` → 换成**统一来源模型(4 列)**,因为 episode 不止来自单条日记,也来自跨多条消息的 scope 蒸馏(DM/话题/主题群,见 `conversation-scopes.md` §4):
  - **`source_scope_id`**(所有 episode 都记):产生这条 episode 的会话 = 日记群 `chatId` / 普通会话 `chatId` / 话题 `chatId:threadId`。
  - **`source_message_id`**(单条消息 episode 用,可空):日记一篇=一条消息;通知群普通回复知识卡也是一条反应消息。它们都指向对应的 `messages.id`;跨多条消息的 scope 蒸馏则为空。
  - **`source_started_at` / `source_ended_at`**(所有 episode 都记):这条 episode 覆盖的消息时间窗。单条消息 episode 两者都等于该消息 `created_at`;scope episode 分别是本次 scope 片段的第一条/最后一条消息时间。
  - 不引入 `source_kind`、不存消息 id 数组、不建 `episode_sources` 关联表。要回查某段 scope 的完整消息集时,按 `source_scope_id + source_started_at/source_ended_at` 查 `messages` 即可,无需冗余存储。
  - 丢弃 DB 外键约束(本地单用户可接受,用软指针)。
- `search_diary`:改为搜 **`episodes_fts`(蒸馏层,已有)** 为主;要原始正文时,单条消息 episode 经 `episodes.source_message_id` join 回 `messages`,scope episode 则按 `source_scope_id + source_started_at/source_ended_at` 回查窗口内消息。

### 5.3 设计权衡(供审核重点关注)

- **为何日记不再单独存 markdown**:日记多是语音转写的粗糙流水,价值在被蒸馏成 episode 之后;真正会被回看的是 episode / 周总结,不是原始转写。把"会浏览的"(知识)放 vault、"只做证据的"(日记原文)留在基建层 `messages`,关注点更干净。
- **原始记录的别用途**(如发给别的 LLM 分析):等真用到时写个一次性脚本从 `messages` 捞,不在本轮实现。
- **search_diary 失去原始全文检索是否可接受**:交互式"懂我"召回主要命中 episodes(蒸馏层);原始逐字检索很少交互需要。**这是一处有意简化**,审核需确认能接受;若将来确需原始全文检索,再给 `messages.content` 加 trigram FTS(届时注意它是基建层、FTS 不区分业务)。
- **迁移**:现有 `diary_entries` 都是测试数据,**不迁移,清库重来**。真实历史日记的导入是单独的一次性脚本,作者后续单独做,不在本轮范围。

---

## 6. SQLite 表去留盘点

| 表 | 处置 | 理由 |
|---|---|---|
| `diary_entries` (+fts+triggers) | **删** | 日记→`messages`(§5) |
| `messages` | **新增** | 基建日志(§3) |
| `episodes` (+`episodes_fts`) | 留,锚点改统一来源模型(`source_scope_id` + 可空 `source_message_id` + 时间窗) | 结构化蒸馏,需 FTS;来源含单条消息与 scope 多条消息两种(§5.2) |
| `working_items` | 留 | 结构化,高频 upsert;工具拆分见 `working-item-tools-and-approval.md` |
| `profile` | 留 | 单条 prose,慢变量 |
| `profile_revisions` | 留 + **补读出口** | 画像审计是真会关心的;加 `/profile history` 之类读出口,否则审计无意义 |
| `weekly_summaries` | 留 | 比 episode 高一层的低成本时间线锚点 |
| `agent_runs` | 留 | 出诡异 bug 时有结构化记录可查,成本低 |
| `schedules` | **删** | 0 读 0 写的死表;定时任务改 `schedules.json`(见 `scheduled-tasks.md`) |
| `chat_registry` | **已删**(现状) | 已搬进 `config.chatBindings` |
| `pending_tool_approvals` | 新增(归 `working-item` 文档) | 结构化/事务/热 → 留 DB,符合判据 |

---

## 7. config.json 承载的结构化配置

`config.json`(`LarkConfig`)是"结构化、人要看/改、整体覆盖、无 FTS、无 join"的配置层:

- **`chatBindings`**(现状):`chatId → chatType`(diary/topic/notification/dm),群绑定不依赖 app.db,重建数据库不丢绑定。
- **`sessionPolicy`**(新增):按 chatType 配置自动关闭策略,详见 `conversation-scopes.md`。
- **`ownerOpenId`**(现状)。

定时任务定义则单独放 `schedules.json`(见 `scheduled-tasks.md`),与本文件并列,同属配置层。

---

## 8. 非目标

- 不为消除"日记正文同时可被 episode 引用"这类弱重复而把基建层和记忆层耦合在一起。
- 不在基建层 `messages` 里写业务判断(它不认识"日记/知识")。
- 不引入向量库 / 外部检索服务;中文检索靠 trigram FTS + LIKE 兜底 + vault 的 ripgrep。
