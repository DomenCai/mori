# 记忆「当前主线」层（chapter）：给纵向洞察一个被重新注入的家

> 日期：2026-06-22。状态：**v3，已纳入 GPT 两轮审查**（见下「修订记录」）。无 blocker，GPT 判「改完即可开工」。
>
> 一句话：weekly 的跨线纵向分析一直在做、且做得好，但它**唯一会被重新注入上下文的产物是 profile**。凡是「比 storyline 慢、比身份快」的连接性洞察，当前无处安放——要么随周记录卡片蒸发，要么被挤进 profile 污染身份层。本文提议补上中间这层货架：一个短的、常驻注入、每周重写、**带审计**的「当前主线」。

---

## 修订记录：GPT 第一轮审查

| 审查点 | 处置 |
|---|---|
| **P1（blocker）Stage 1 夹带 profile 数据清理** | 接受。Stage 1 **不含任何对已有 profile 数据的改动**，只加「今后不进 profile」的写入规则。已有内容清理拆成独立、需用户确认、走 `updateProfile`（自带审计）的**可选**操作，不放进 schema/feature 迁移。 |
| **P2（should-fix）chapter 无审计与可追溯冲突** | 接受，且承认原稿「派生可重建故免审计」的理由有误——chapter 是**有损综合**，重建不出来。建最小 `chapter_revisions`，镜像 `profile_revisions`；`set_chapter` 带 `reason` + `run_id`。 |
| **P2（should-fix）缺部署态 DB 升级/激活说明** | 接受，但修法更省：读 `schema.sql` 确认全是 `CREATE TABLE IF NOT EXISTS`，**新表无需升 `DB_SCHEMA_VERSION`、无需进 `applyDbMigrations`**（那套只为 ALTER 老表）。补「升级验收」与「初始激活」两节。 |
| **P3（non-blocking）docs 覆盖不全** | 接受。新增显式同步项：`docs/memory-model.md`、`docs/persona.md`、`README.md`。 |
| 开放问题 | 按 GPT 判断收敛：做 A / 建审计 / 折进 mechanical 轮 / ≤500 字夹中间 / 已有 profile 不自动剪 / **删除 Stage 0**。 |
| 本轮新增风险（GPT 未提） | mechanical 轮将同时承担「画像保守门控 + 周记录 + chapter 扩张综合」三职，心态相反可能互扰。仍折进，但列为风险并留「拆独立 step」后路。 |

---

## 修订记录：GPT 第二轮审查

| 审查点 | 处置 |
|---|---|
| **P2（should-fix）weekly 写 chapter 缺「当前 visible storylines」输入** | 接受（已核代码：mechanical 轮确实只读 `本周 storylineChanges + episodes + profile`）。mechanical prompt 注入 `currentVisibleStorylines = memoryService.getVisibleStorylines()` 作 chapter 的现状底，本周 changes 仅作「本周什么动了」证据。**追加（GPT 未提）**：此输入按子任务分区——只服务 chapter，profile 子任务仍只凭本周新鲜证据门控，不被 standing state 松动。 |
| **P2（should-fix）`chapter_revisions` 不能只用 episode ids** | 接受（原是 §10 开放问题）。`source_storyline_ids_json` 作主证据字段，`source_episode_ids_json` 降为可选 raw anchor。 |
| §10-1 mechanical 轮 | 折进、不先拆；前提是补 visible storylines + 输出分段；质量不行再拆。 |
| §10-2 审计字段 | storyline_ids 为主、episode_ids 可选。 |
| §10-3 初始激活 | 默认被动等下次 weekly；要演示再 seed，seed 走 `sendCards=false`（+ 本文追加 `friendRound=false`）的内部窗口跑法，避免重复发周报。 |
| §10-4 B-cleanup | 确认后**删除**，不转 vault（vault 只是给噪音换地方续命）。 |

---

## 一、背景与现状核验

记忆按保质期分了三层货架（见 `agent/memory_policy.md` 与 `src/agent/prompts.ts` 的 `buildSystemPrompt`，属于 cognitive-lenses 文档里说的「layer 2 记忆上下文」）：

| 货架 | 是什么 | 维护者 | 注入 |
|---|---|---|---|
| episode | 单次会话蒸馏，证据层 | 热会话 `write_episode` | 仅 fresh 少量注入，其余按需检索 |
| storyline | 当下正在展开的若干条线 | `daily_memory` 的 dream_agent（每天） | active 全量 + recent dormant 少量 |
| profile | 稳定身份 | `consolidation`（每周） | 始终注入 |

本设计基于对 `data/app.db` 的实测（导入了约 3.5 个月真实日记，2026-03-04 → 06-21）：

- 80 篇日记 → 80 条 episode，100% 已消化；106 个 daily run、15 个 weekly、91 条 storyline 修订、8 次 profile 改写。
- 最终压缩为 **9 条 storyline（5 active / 4 dormant / 0 closed）**，**profile 1098 字**。
- 管线质量高：8 次 profile 改写每次都引跨篇原文、是「精确化」而非堆砌，未踩心理定性红线。
- 这份库由**早于 friend 轮**的版本生成（`weekly_summaries` 尚无 `friend_note` 列，`user_version=0`），且几乎无 live 对话（仅 3 条 lark 用户消息）。

**规模警告（必须诚实对待）**：9 条线、1098 字的 profile 都很精瘦，dormant 才 4 条。所以「坟场堆积 / profile 膨胀到需要 GC」这类**扩展性**问题现在**不存在**，本文不为它们设计任何东西。促使现在动手的是下面这个**当下就可观测的结构缺陷**，与规模无关。

---

## 二、根因：不是没人重组，是重组的产物回不到上下文

一个容易下错的判断是「需要加一个站得更远的月度重组 pass」。实测推翻了它——**跨线的纵向分析一直在发生，而且质量很高**：

- dream_agent 给 storyline 写的 `advance` 理由里，会主动把「公司开掉一个不投入的前端」与「用户自己上班做私活」做映射，并注明「用户未明确意识到这个对照」。
- weekly 的 `summary` 把某一周读成「身体强制减速 + 新机会萌芽并存」，把疲劳、公司加码 KPI、叶佳新合作三条线收成一句。

问题不在分析，在**这些分析写到哪儿去了**。核对 `buildMemorySnapshot`（`src/agent/prompts.ts`）实际读取的字段：profile、storylines 的 `summary/current_tension/emotional_arc`、fresh episode 的 `brief`、知识地图。**它不读 `storyline_revisions.reason`，也不读 `weekly_summaries.summary` / `friend_note`。**

于是形成一条**单向漏斗**：

```
dream / weekly 辛苦连出的跨线洞察
   → 落进 storyline_revisions.reason / weekly_summaries.summary（审计表）
   → buildMemorySnapshot 不读它们
   → 永远回不到 agent 的工作上下文
```

weekly 一轮跑完，能把「本周的纵向读」带进未来上下文的**唯一通道就是 profile**。而 profile 又（正确地）被锁成「只收慢变的身份信号」。结果：**凡 weekly 看到、但不够身份级的东西，出生即死亡。**

### 已经长出来的症状：profile 被污染

看 profile 最长的「AI使用观」段：「GPT 什么都好就是太慢」「Claude 适合快速开发」「GPT 解决技术卡点比 Claude 强」——这些是 4–5 月的**战术性、月度即过期**判断（对应 `profile_revisions` 里 2026-04-26、05-24 两条），却被写进了**每轮永远注入**的身份层。

它们为什么在那儿？因为身份层是唯一持久的货架，**它们没有别的地方可去**。这不是一次失误，是结构性压力：每当 weekly 看到一个强的、跨线的、但非身份级的信号，它就只有两个出口——丢掉，或往 profile 里挤。这个压力会反复发生。

**结论：缺的是一个「被重新注入的纵向层」，不是一个「分析器」。**

---

## 三、设计判断

### 1. 缺的是一层货架，形状照抄 profile

在 storyline 与 profile 之间补一层 **「当前主线」（handle: `chapter`）**：

- **定义**：此刻横跨多条 storyline 的那条主线、反复出现的卡点、用户正处在什么阶段。是**连接**，不是某一条线。
- **保质期**：比 storyline 慢（不随单天 episode 抖动），比 profile 快（每周重写，自然衰减）。
- **形状**：和 profile 同构——一个单行、可整体重写的文本块，常驻注入，**配一张审计表**（见 §3.5、§4）。profile 已经验证了这个形状能用，照抄，不发明新机制。

> 命名注意：storyline 里已有 `emotional_arc` 字段，故本层 handle 用 `chapter` 而非 `arc`，避免概念撞名；中文叫「当前主线」。

### 2. 写权限分离不动；`chapter` 由 weekly 写

- storyline 仍归 daily、profile 仍归 weekly，这条分离是干净的，**不要破**。
- `chapter` 的天然写者是 weekly——跨线的读本来就发生在这里。它是**唯一合法同时读到 profile + 全部 storyline 的 pass**。
- **不让 daily 碰 chapter**：daily 只看昨天 fresh episodes，视野太窄，会把当前主线写抖。保持「比 storyline 慢」这个性质靠的就是只在 weekly 重写。

### 3. 它写「连接」，不复述 storyline

active storyline 已经全量注入了。`chapter` 若只是把 5 条线的摘要再列一遍，就是纯浪费 token。它的全部价值在**跨线的那一层**：5 条线背后其实是哪 1–2 条主线、哪个卡点这几周反复出现、上一阶段到这一阶段转了没有。Prompt 必须把「不复述单条 storyline」写成硬约束。

### 4. 红线照搬 `memory_policy`，且这里是最危险的注入点

`chapter` 是全系统**综合度最高**的一层，因此也是最容易滑向「心理状态定性 / 人格结论 / 未确认推断」的地方（`memory_policy.md` 的高风险红线）。它最可能写出「你有逃避倾向」这种话。

所以：把 memory_policy 现有红线**原样套到 chapter 写入**，并额外强调一句——chapter 描述**处境与主题**（situational / thematic），不下**心理与人格判断**。例：

- ✅「这几周的主线是『有想法但执行依赖外部推力』，横跨叶佳项目 / 公司博弈 / 自驱力三条线；身体疲劳信号反复出现。」
- ❌「你是个执行力有障碍、靠逃避来自我保护的人。」

这一层是红线风险最高的写入，正是它**必须**有审计的理由（见 §3.5）。

### 5. chapter 必须带审计（修订自 v1：原稿主张免审计，错）

v1 主张「chapter 派生可重建，故不建审计表」。这个理由是错的，纠正：

- chapter 是**有损综合**——storyline 里没有「那条跨线主线」，所以从 storyline **重建不出**一次具体的 chapter 写入。
- 它是红线风险最高、整体覆盖、常驻注入的模型产物。一旦写出心理定性、错把临时状态当主线、或周间抖动，**只有当前值就等于无法排查、无法回滚**。
- profile 和 storyline 都有审计表；chapter 不建，会成为全系统**唯一**不可回溯的记忆写入——方向正好反了。这属于用户 CLAUDE.md 列明的「审计=必要复杂度」例外。

定论：建最小 `chapter_revisions`，字段镜像 `profile_revisions`，但**主证据字段是 `source_storyline_ids_json`**（chapter 综合的是「线」不是单条 episode），`source_episode_ids_json` 降为可选 raw anchor。`set_chapter` 必须带 `reason`、串入 weekly 的 `run_id`。带 `reason` 这个要求顺带也压住了「周间无谓抖动」（要改就得给出理由）。

### 6. profile 卫生：今后规则进 Stage 1，已有内容清理单独走（修订自 v1）

补 `chapter` 会**缓解** profile 的污染压力（跨线内容今后有地方去），但**不会、也不应该自动清掉已经写进 profile 的内容**——那是从用户日记蒸出来的真实运行时数据。拆成两件互不绑架的事：

- **进 Stage 1 的**：只是一条**今后**的写入规则（「月度即过期的工具/战术判断不进 profile」），不动任何已有数据。
- **不进 Stage 1 的**：已有「AI使用观」战术内容的清理，是一次**独立、可选、需用户确认**的操作——给出精确 diff，经确认后走 `updateProfile`（自带 `profile_revisions` 审计），既不自动剪、也不默认塞 chapter；确认后删除而非转 vault（见 §6 B-cleanup）。

---

## 四、具体改动（落到文件 / 函数）

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/storage/schema.sql` | 新增 `chapter(id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL, updated_at TEXT NOT NULL)`；新增 `chapter_revisions(id TEXT PK, old_content TEXT, new_content TEXT NOT NULL, source_storyline_ids_json TEXT NOT NULL DEFAULT '[]', source_episode_ids_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL)`，均用 `CREATE TABLE IF NOT EXISTS` | 小 |
| `src/storage/db.ts` | 仿 `ensureProfileRow` 加 `ensureChapterRow`（初值空串）。**不升 `DB_SCHEMA_VERSION`、不加 `applyDbMigrations` 分支**——新表经 `db.exec(schema)` 幂等创建即可 | 微 |
| `src/memory/service.ts` | `MemoryService` 加 `getChapter(): string`、`setChapter(data: SetChapterData, runId?: string): void`（整体覆盖 content + 更新 `updated_at` + 写一条 `chapter_revisions`，逻辑镜像 `updateProfile`）；加 `getChapterRevisionsByRun(runId)` | 小 |
| `src/agent/schemas.ts` | 加 `SetChapterParams = { content: string; reason: string; source_storyline_ids: string[]; source_episode_ids?: string[] }`（整体重写，不分 add/replace/remove；`reason` 必填、`source_storyline_ids` 主证据、`source_episode_ids` 可选 raw anchor） | 微 |
| `src/agent/tools/set-chapter.ts` | 仿 `update-profile.ts` 新建 `set_chapter` 工具，调 `memoryService.setChapter(params, getRunId?.())` | 微 |
| `src/agent/prompts.ts` | `MemorySnapshot` 加 `chapter: string`；`buildMemorySnapshot` 读 `chapter` 表；`buildSystemPrompt` 在「身份画像」与「Storylines（active）」之间注入 `# 当前主线`（**仅当非空**） | 小 |
| `src/agent/harness.ts` | `set_chapter` 仅在 `isConsolidation` 时加入 `allTools`（镜像 `canEditProfile`）；不进任何热会话工具集 | 微 |
| `src/memory/consolidation.ts` | mechanical 轮 `setActiveTools([...])` 加 `set_chapter`；prompt 注入「当前 chapter 原文」**+ `currentVisibleStorylines = memoryService.getVisibleStorylines()`（chapter 的现状底）**，本周 `storylineChanges` 仅作「本周什么动了」证据；追加「刷新当前主线」指令块（含 §3.3/§3.4 约束）。**输入分区**：visible storylines 只供 chapter 子任务，profile 子任务仍只凭本周新鲜证据门控 | 中 |
| `agent/memory_policy.md` | 文档化新层（插在 ① profile 与 ② storyline 之间）、红线、profile 卫生规则 | 小 |
| `docs/memory-model.md`、`docs/persona.md`、`README.md` | 同步：四层→五层（profile / **chapter** / storylines / fresh episodes / archive），见 §6-P3 | 小 |

### 升级与初始激活（回应 P2）

**升级是 trivial 的，但要做这个验收**。当前 `data/app.db` 处于 `user_version=0`、无 `friend_note`。新代码 `initDb` 的执行序是 `db.exec(schema)` → `applyDbMigrations()` → `ensureProfileRow` → `ensureChapterRow`：

- `db.exec(schema)` 幂等创建 `chapter` / `chapter_revisions`（老库没有就建，有就跳过），**与 `user_version` 无关**。
- 既有的 v1 迁移仍会给这库补 `friend_note`、把 `user_version` 推到 1——和本改动正交。

验收步骤（拿一份当前 DB 副本跑）：

1. 复制 `data/app.db` → 跑 `initDb`。
2. 断言旧表行数不变（messages=86 / episodes=80 / storylines=9 / profile=1 …）。
3. 断言 `chapter`、`chapter_revisions` 出现，`chapter` 有一条 `id=1` 的空串行。
4. 断言 `friend_note` 列出现、`user_version=1`（本改动不引入新迁移版本）。

**初始激活**：chapter 初值为空，而 `buildSystemPrompt` 仅在非空时注入，故空 chapter **无害**，只是暂无收益。第一版内容有两条路：

- 被动：等下一次正常 weekly consolidation 自然写出；或
- 主动 seed：显式跑一次 `runWeeklyConsolidationForWindow` 指定最近窗口（已支持 since/until），**务必 `sendCards=false` + `friendRound=false`**，否则会向日记群重复发周报/朋友卡。注意副作用：seed 会 `INSERT OR REPLACE` 重写该窗口的 `weekly_summaries`、并重跑一次 profile 评估——因 profile 是证据门控，通常是 no-op，但需知晓。

建议默认走被动等下次 weekly；要演示效果再 seed。

### 注入位置与形态

`buildSystemPrompt` 现有段落顺序是 soul → memory_policy → response_style → 身份画像 → Storylines(active) → Storylines(dormant) → fresh episodes → 知识地图。

在「身份画像」之后、「Storylines(active)」之前插入 `# 当前主线`。语义上正好是一条由抽象到具体的下行：**你稳定是谁（profile）→ 你正处在哪一章（chapter）→ 构成这一章的具体线（storylines）→ 最新信号（fresh）**。

形态约束：短（建议 ≤ 400–500 字），纯连接性叙述，无 bullet 罗列，声音由常驻的 `soul.md` 统一管（与 cognitive-lenses 同原则：方法/内容层不自己讲怎么说话）。

### weekly 写入：折进 mechanical 轮，不新增 agent

`runWeeklyConsolidationForWindow` 已有 mechanical 轮（判画像 + 出周记录）和 friend 轮。**把 chapter 刷新折进 mechanical 轮**：它本就读到 profile + 本周 storylineChanges + episodes，只需再喂「当前 chapter 原文」并允许 `set_chapter`。理由：避免多一次 agent 调用；mechanical 轮的心智（「这周变了什么、我们到哪了」）与 chapter 同源。

> 风险（见 §7）：mechanical 轮由此承担三职，其中「画像保守门控」与「chapter 扩张综合」心态相反，可能互扰。若 review 发现质量下降，退路是拆成独立的 chapter step。

**不要**让 friend 轮写 chapter：friend 轮是写给用户看的暖声音（`runFriendAgent`，prompt 明写「像给我写几句话」），把那种第二人称语气注入系统提示会造成自指错位。friend note 继续当**消息**（发卡片、存档）即可——它「漏」不是问题，因为它本就是对人说的话，不是要回灌的记忆。chapter 是另起的、中性的、第三人称综合。

---

## 五、备选方案与否决理由

| 方案 | 否决理由 |
|---|---|
| **A. 按 query 过滤 active storyline（RAG 式）** | 陪伴 agent 的价值正是跨域连续性（聊代码也能想起关系线）；active 已被 `MAX_ACTIVE_STORYLINES=12` 兜住成本，过滤是把护城河填了。 |
| **B. 加月度/季度 GC / 重组 pass** | 9 条线、profile 1098 字，远未到需要清理的规模；且真缺口是「再注入」不是「再分析」。属过早优化。 |
| **C. 让 weekly 直接写 storyline** | 破坏 daily=storyline / weekly=profile 的写权限分离，两个入口改同一层会打架。 |
| **D. 注入时即时从审计表合成 chapter** | 把综合成本压到每次 session 创建；且审计文本含机械日志，源不干净。 |
| **E. 直接把最近 weekly summary 原样注入（曾作 Stage 0）** | recap 是「本周事件摘要」而非「跨线主线」，信号偏弱且噪音大，会误导；审查判定不值得，**已删除**，直接做带审计的 Stage 1。 |
| **F. 把跨线洞察继续塞进 profile** | 这正是当前的失败模式——用月度即过期的内容污染恒久身份层。 |

---

## 六、两个工作项（相关但独立）

**A（主）：建 `chapter` 层 + 审计** —— §三、§四全部。结构性修复。这是 Stage 1 的内容。

**B：profile 卫生** —— 拆成两半，互不绑架（修订自 v1，回应 P1）：
- **B-rule（进 Stage 1）**：在 `memory_policy.md` 立规则——月度即过期的工具/战术判断不进 profile（阶段性的归 chapter，可复用知识走 vault，都不算就不写）。只约束**今后**，不动数据。
- **B-cleanup（不进 Stage 1，独立 + 需确认 + 可选）**：已有 profile 战术内容的清理。给精确 diff → 用户确认 → 走 `updateProfile`（写 `profile_revisions`）。不自动、不默认塞 chapter。确认后**删除，不转 vault**——那段是过期工具体感不是可复用知识，转 vault 只是给噪音换地方续命。

---

## 七、风险与缓解

| 风险 | 缓解 |
|---|---|
| **mechanical 轮过载 / 心态互扰 / 输入分歧**（新增）：一轮内同时做画像保守门控（要本周新鲜证据）+ 周记录 + chapter 扩张综合（要 visible storylines 现状底），心态与输入都相反 | prompt 把三项目标与各自输入**显式分区**，防 standing state 渗进 profile 门控；review 盯 chapter 是否被「保守别改」拖成空话；质量不行则拆独立 chapter step |
| **chapter 抖动**：每周重写若方差大，注入上下文 session 间不稳定 | prompt 要求「默认延续上周 chapter，只在主线真的转章时才改写」，照搬 profile 稳态纪律；`reason` 必填进一步约束 |
| **红线**：综合度最高，最易写成心理/人格定性 | §3.4 硬约束：只写处境与主题；套 memory_policy 全部红线；`chapter_revisions` 保证可排查可回滚 |
| **与 storyline 冗余**：退化成复述 5 条线 | §3.3 硬约束「只写跨线连接，不复述单条 storyline」；review 盯这一点 |
| **自指错位**：误用 friend 第二人称声音 | chapter 由 mechanical 轮中性写入，friend 轮不碰 |
| **成本** | 每周多一次 `set_chapter`（在已有 agent 轮内，可忽略）；每 session 多注入数百字（profile 已 ~1100 字，可忽略） |

---

## 八、分期与验证（诚实对待数据规模）

**Stage 1（唯一阶段，Stage 0 已删）= A + B-rule**：

- A：`chapter` 表 + `chapter_revisions` 审计 + service/tool/schema/prompts/harness/consolidation 接线（§四）。
- B-rule：memory_policy 立「今后不进 profile」规则。
- docs 同步（§6-P3）。
- 小、可逆；**不含任何对已有用户数据的修改**。

**为什么现在就值得做（而非等规模）**：触发条件不是未来的线数，是两个**当下事实**——(1) profile 已被月度即过期内容污染，且这压力会结构性复发；(2) 当前代码的 friend 轮已经在产出跨线读却被丢弃，产能已付。两者都与「9 条还是 90 条」无关。

**必须靠 live 使用才能验证、本数据给不了的**：chapter 的周间抖动率、注入 chapter 是否真的改善 live 回应质量、profile 污染是否随规则落地而停止增量。这些是**部署后**观测的假设，本设计不假装现有 80 篇导入数据能证明它们。

---

## 九、明确不做

- 不做按 query 过滤 active storyline（方案 A）。
- 不做月度/季度 GC / 重组 pass（方案 B）——直到 live 实测出现 dormant 坟场堆积或 profile 膨胀的真实证据。
- **不在本轮、不自动**修改任何已有 profile 内容（B-cleanup 单独走，见 §6）。
- 不做 Stage 0（weekly recap 弱信号会误导）。
- 不让 daily 或 friend 轮写 chapter。
- 不把 storyline 的「真正闭环（closed）」缺失一并塞进本轮——那是 dream_agent 指令层的另一个问题（实测 0 closed），单独开。

---

## 十、状态：设计冻结，实现就绪

两轮审查的全部 blocker / should-fix / 开放问题已收敛进上方两张「修订记录」表。第二轮 §10 的 4 个开放问题已分别判定（mechanical 轮折进、审计以 storyline_ids 为主、初始被动激活、B-cleanup 删除不转 vault），无残留待决项。

Stage 1 范围已冻结：**A（chapter 表 + `chapter_revisions` 审计 + service/tool/schema/prompts/harness/consolidation 接线）+ B-rule（memory_policy 立「今后不进 profile」）+ docs 同步**，全程不触碰任何已有用户数据。B-cleanup 作为独立、需确认的可选操作另走。

可以开工。
