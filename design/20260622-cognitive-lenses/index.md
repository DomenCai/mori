# Cognitive Lenses（思考透镜：think / rank / plain）

> 日期：2026-06-22。状态：已实现，待审查。本文定义如何把 ljg-skills 里的认知方法以「思考透镜」形态接入 PersonalAgent，并记录实现后的审查重点。

## 背景

`ljg-skills`（一套 Claude Code 自定义技能集，/Users/caidongmeng/Documents/Github/ai/Skills/ljg-skills）里有大量「认知操作」类 skill：把一个概念钻到本质、把一个领域砍到最少几根生成器、把任何东西讲到聪明的十二岁小孩能懂。它们和 PersonalAgent 的内核定位「私人思想伙伴」（见 `agent/soul.md`）高度同源。

但两者本质不同：

- ljg-skills 是 **Claude Code 的 skill**，靠 `~/.claude/skills/` + Claude Code 这个宿主调度。
- PersonalAgent **不是 Claude Code**，它跑自己的 `@earendil-works/pi-agent-core` harness，宿主是飞书 bot。

所以 ljg-skills 不能「装」进来。能搬的不是 skill 这个包，而是每个 `SKILL.md` 里那套**方法论（prompt）**。每个 ljg skill 几百行，其中约 80% 是输出机械（org-mode 文件头、denote 命名、九种 ASCII 取景框、写盘到 `~/Documents/notes/`），对本项目全是噪音，直接丢；真正要搬的「思考骨架」压完只剩十几行。

本轮范围：接入 **think（下钻）、rank（降秩）、plain（白话）** 三个认知方法，作为飞书斜杠命令。其余 ljg skill（card / present / library / travel / paper / book / read / roundtable / relationship / learn / writes / qa）本轮不接，理由见末尾「明确不做」。

## 核心判断

### 1. 搬方法骨架，扔输出格式；声音归 soul

ljg 原版 prompt 自带强格式与文学化输出要求（org-mode、ASCII 图、「写一场下坠」「一气呵成的散文」），这些和 `soul.md` 的声音定调（说人话、不端着、不要 bullet 式总结、不用三段论、不用空泛大词）直接冲突。直接复制 prompt 会让 agent 出戏。

正确做法：只提炼**思考动作**，输出声音交给 systemPrompt 里常驻的 `soul.md`。因为声音由 soul 统一管，方法 prompt **不需要再讲怎么说话**，于是能压到极短。

`/think` 的提炼样板（60 行 SKILL → 这样）：

```
把刚才那件事往下钻，别往旁边扯。

- 每往下一层只回答「为什么会这样」，不是「还有什么」。横着铺是偷懒。
- 每层尽量换一个更底层的框架看：社会层底下是心理层，心理层底下是生物/物理层，再底下是逻辑本身。怎么换看题目。
- 钻到一层，顺手点出这层里那个还没解决的矛盾，那就是往下一层的入口。
- 钻到再问「为什么」只剩同义反复，或者撞上人性的硬结构、物理定律、逻辑本身、一个绕不开的悖论，就到底了。浅的三层，深的六七层，自己判断。
```

思考骨架（纵向不横向 / 每层换框架 / 裂缝即入口 / 到底的四种标志）一个没丢，文学表演和格式全没了，声音是 soul 的。rank、plain 同理提炼。

### 2. 一个 soul，不按群分人格（已解开的心结）

讨论中出现过一个诱惑：既然每个 ljg skill 各有「核心想做的事」，是不是每个群该有自己的 soul？

结论：**不**。这是把两个不同的轴搅在一起了。

当前 system prompt 已经是分层的（`src/agent/prompts.ts` 的 `buildSystemPrompt` + `src/agent/harness.ts` 的 `appendSessionInstructions`）：

| 层 | 是什么 | 内容 | 是否按群区分 |
|---|---|---|---|
| 1 人格内核 | 你是谁、怎么说话 | `soul.md` + `response_style.md` | 共享，一个人 |
| 2 记忆上下文 | 你知道关于我什么 | 画像 / storylines / episodes / 知识地图 | 共享 |
| 3 场景纪律 | 这个场合的规矩 | `appendSessionInstructions`（按 chatType） | 已按群区分 |
| 4 当下出招 | 这一轮用什么思考动作 | lens 注入（本轮新增） | 按命令区分 |

ljg-think 不是一种性格，是一个动作。装 100 个 ljg skill，背后还是同一个 Claude Code 在出不同的招；本项目同构，不管哪个群、哪个 lens，背后永远是同一个 soul。

「不同群不同 soul」是过度设计且有害：会撕裂「同一个很懂我的朋友」这个产品内核（`soul.md` 整篇的前提），会让声音规则被复制多份逐渐漂移，而且开发者真正想要的「不同群不同目的」其实是 **layer 3 已经在做的事**。lens 属于 **layer 4**，是方法不是人格。

**定论：soul 保持一个。群与群差异走 layer 3；这一轮出什么招走 layer 4。人格恒定，方法流动。**

## 三个 lens 各自做什么

| 命令 | 干嘛 | 方向 | 何时喊它 |
|---|---|---|---|
| `/think` | 钻到本质 | 向下挖深 | 一件事想不透、隐约知道有更深的原因 |
| `/rank` | 砍到几根线 | 向内收宽 | 一个领域糊成一团、想要可记住的骨架 |
| `/plain` | 讲到能复述 | 横向换说法 | 一个概念没听懂，要大白话 |

- **think（下钻）**：单方向向下，顺着「为什么会这样」一层层挖，每层换更底层的解释框架，直到撞上挖不动的硬地基（人性结构 / 物理定律 / 逻辑本身 / 绕不开的悖论）。不列选项、不权衡，只追问到底。对应 soul 的「逻辑自洽但行动卡住时直接点破盲点」。
- **rank（降秩）**：把一个看着几十个变量的领域，砍到背后真正独立、互不能推导的两三根「生成器」，并验证能不能用这几根反推回全部现象。判据借自 Deutsch《无穷的开始》：好解释动一根就塌，坏解释怎么改都还能用。砍完读者拿到的是「世界观」，不是清单。
- **plain（白话）**：不产出新理解，只换说法。把任何东西用最笨的大白话重写：零术语、短词、一句一事、能类比就类比、能讲成具体的人遇到具体的事就讲故事。验收：读完能用自己的话复述且记得住。注意 plain 的大半要求 soul 已有，它真正多出来的只有「类比/画面/故事/裂缝」这套讲解工具箱，和一个比日常聊天更极限的通俗档（明确降到十二岁能复述）。

rank、plain 的方法骨架在实现时按「核心判断 1」的方式从 `ljg-rank/SKILL.md`、`ljg-plain/SKILL.md` 提炼成 soul 声音的短 prompt（丢掉 org-mode、ASCII 九宫格、denote、母语化闸等输出机械）。

## 统一接入机制

### lens 是聊天流的变体，不是 command 的变体

`/think /rank /plain` 不该和 `/profile /storylines` 那类纯查询/CRUD 命令放一起。后者发段文字就完事；前者要驱动 harness、流式出卡片，和 `handleChatMessage`（`src/lark/messageHandlers.ts:167`）是一回事。

它复用现有的**流式、卡片**机制，但**不复用** `handleChatMessage` 本身——后者带着 `promoteKnowledgeIfNeeded`、`formatChatPrompt` 等普通聊天副作用，lens 不需要。所以抽一个**瘦 lens runner**（`handleLensMessage`），它和 `handleChatMessage`/`handleDiaryMessage` 共用同一个流式卡片 producer（见下「实现拆分」第 2 步：把那段重复的 producer 提成 `streamAgentReply` helper），但 prompt、工具、副作用三处都按 lens 规则走。**不新开 chatType、不新开 route。**

### 路由：handleCommand 放行，main.ts 统一分流

当前 `main.ts:131` 先跑 `handleCommand`，而它对任何未知 `/` 命令返回 `handled:true`（`commands.ts:75`），会把 `/think` 截成「未知命令」。修法：

- `handleCommand` 开头加一行——`parseLens(text)` 命中就 `return { handled: false }`，放行。lens 概念上不是 command，是聊天变体。
- `main.ts` 在 `resolvedType` 解析之后、按类型分发之前插一段：`parseLens` 命中且 `resolvedType !== "diary"` → 调 `handleLensMessage(..., lensChatType, lens)` 并 return；其中

  ```
  lensChatType = (msg.threadId || resolvedType === "notification") ? "thread" : resolvedType
  ```

  即 dm/topic 原样保留，**带 threadId 的回复和通知群直接回复都按 `thread` 语义跑**。这条很关键：`HarnessEntry.chatType`（`harness.ts:38`）的合法值是 `diary | dm | topic | thread | …`，**没有 `notification`**；`handleChatMessage` 的 `chatType` 形参也只收 `dm | topic | thread`。所以 `lensChatType` 绝不能落到 `notification`，否则要么编译不过，要么逼实现者新开 chatType——正好违反本文「不新开 chatType」铁律。把通知群直接回复映射到 `thread` 不是新发明：通知群的深聊路径（`main.ts:150` 的 thread 回复）本来就走 `handleChatMessage(..., "thread")`，lens 只是和它对齐。
- scopeId 沿用 `handleChatMessage` 的现成规则——所有 chatType 都用 `message.conversationId`（`messageHandlers.ts:174`），thread 也不例外。lens 不为通知群直接回复单造「以父消息为粒度的 scopeId」，那是过度设计；同一通知群的 lens 复用同一个 thread harness 即可。

这样通知群里 `/plain` 不论走 thread 回复（`main.ts:150` 本就路由到 thread）还是直接回复（落到 notification 分支前被 lens 拦截，按 `thread` 语义进 companion runner），都进同一个 runner，**不必再改 `handleNotificationMessage`**。

### 三条正确性铁律（lens runner 必须守）

1. **只读，不碰知识库**：lens runner **不调** `promoteKnowledgeIfNeeded`。`/plain` 回复 Inbox 卡片只把父消息正文注入并解释，绝不把卡片 rename 进 Garden、绝不拿命令文本写 `my_note`。收藏是普通非 lens 反应的事。
2. **工具单轮、用完即还**：进 runner 时从 harness 当前 active tools 读取 `restoreToolNames`，`setActiveTools`（plain 开 `fetch_article`，若 `web_search` 配置和 key 都存在则同时开启；think/rank 清空），`finally` 里恢复 `restoreToolNames`。不要用 `entry.activeToolNames` 当恢复来源，它只是创建时快照。
3. **日记群不支持 lens**：lens 只在 dm / topic / thread / 通知群回复生效。日记群（`resolvedType === "diary"`）直接排除，`/think` 之类在日记群里就按普通日记内容走原路径（开发者不会在日记群用这些命令，无需额外拦截）。

### 对象解析规则

命令作用的「对象」必须明确，二选一，否则不生效：

```
/think <内容>          → 对象 = <内容>
/think（作为回复某条）   → 对象 = 被回复消息的内容
/think（光秃秃，非回复） → 不生效，回一句提示「命令后面给内容，或回复某条消息」
```

### 回复态只取父消息正文

普通聊天里的 `buildReplyContext` 是给「把父消息脚手架 prepend 到当前用户消息前」用的，它会拼出 `[reply_to 原文]`、知识卡片提示和 `--- 当前用户消息 ---` 抬头。lens 的对象不是一段聊天 prompt 前缀，而是独立分析对象，所以不能直接拿 `buildReplyContext` 的整段输出。

正确做法：lens 回复态沿用同一个取数来源（`message.replyTo ?? message.rootId` → `messageService.get(...)`），但只取父消息的干净 `content` 作为对象。知识卡片也一样：`/plain` 回复某张知识卡片时，父消息正是那张卡片，lens 只解释卡片正文，不把 `[reply_to 原文]` 或 `--- 当前用户消息 ---` 这类脚手架塞进对象里。

通知群里 `/plain` 回复某张知识卡片 → 父消息正是那张卡片 → 直接读取父消息正文，无需特殊推送路由（不动 `send_checkin`）。输出回到命令发出的那个会话本身。

## plain 的资料采集：web_search

### 为什么需要

plain 要在「我不熟的主题」上讲得准，光靠模型参数知识不够——模型在小众 + 最新主题上最不可靠，而这正是 plain 常要讲的。当前项目只有 `fetch_article`（URL → 正文，`src/agent/tools/knowledge.ts:24`），没有网络搜索（关键词 → 结果）。这个需求有具体证据（准确的知识卡片），过得了「必要复杂度」线。

### 不绑死在 plain，但必须按配置启用

一旦有 `web_search`，普通陪伴对话也可以使用它，所以它是 companion harness 的通用工具，不是 plain 专属特例。但它必须在 `setting.knowledge.search` 和对应 env key 都存在时才注册、才放进 active tools；否则普通聊天和 `/plain` 都不能暴露这个工具，避免老部署因为缺搜索 key 而让普通回复失败。

输入分两种，两条路都留：给 URL 走 `fetch_article`，给词/概念走 `web_search`，不重复造。

### 两个 provider，配置二选一，最小形态

开发者明确要 Tavily 与 Brave 都支持、由配置决定用哪个。这是「两个真实现」，抽象成立（是 `soul.md` 代码原则里「必要复杂度」的正当例外）。但压到最薄：

- 配置加 `knowledge.search`：`provider: "tavily" | "brave"` + 各自 `apiKeyEnv`（`TAVILY_API_KEY` / `BRAVE_API_KEY`）。只有配置和对应 env key 都存在时才启用工具。
- **一个** `web_search` 工具，`execute` 里一个 `switch(provider)`，分别调 `searchTavily(q)` / `searchBrave(q)`，两者归一化成 `{ title, url, snippet, content? }[]`。
- **不写** `SearchProvider` interface / registry / factory。一个函数两个分支 + 两个具体函数即止。

provider 差异：Tavily 一次调用就带清洗正文（填 `content`）；Brave 只给链接+摘要（`content` 留空，模型自己决定是否再 `fetch_article` 读）。归一化形状里 `content` 设为可选，两边都装得下，不浪费 Tavily 长处。

## 实现拆分

1. `src/lark/` 加 `parseLens(content)` → `{ lens: "think" | "rank" | "plain", body: string } | null` 小解析。
2. 把 `handleDiaryMessage` / `handleChatMessage` 里那段重复的流式卡片 producer（订阅 harness 事件 → 累积 text_delta → 更新卡片 → 收尾 metrics，`messageHandlers.ts:62-153` 与 `190-255` 近乎逐行重复）提成共享 helper `streamAgentReply(channel, msg, entry, runPrompt)`，供两个旧 handler 和新的 `handleLensMessage` 共用。这是已存在的重复，不是为 lens 投机抽象。
3. 新增 `handleLensMessage(msg, ingested, channel, harnessManager, chatType, lens)`：
   - 对象 = `lens.body` `||` 通过 `message.replyTo ?? message.rootId` 捞到的父消息正文；两者皆空 → 回提示「命令后面给内容，或回复某条消息」并 return；
   - `saveUserMessage`；从 harness 当前 active tools 读取 `restoreToolNames`；
   - `setActiveTools`：plain → 有搜索 key 时 `["web_search","fetch_article"]`，无搜索 key 时 `["fetch_article"]`，think/rank → `[]`；
   - 经 `streamAgentReply` 发 `lensPrompt[lens](对象)`；
   - **不调** `promoteKnowledgeIfNeeded`（只读铁律）；`finally` 恢复 `restoreToolNames`；
   - `saveAssistantMessage`（与普通聊天一致，便于会话片段蒸馏）。
4. `commands.ts handleCommand` 开头：`parseLens(text)` 命中 → `return { handled: false }`。
5. `main.ts`：`resolvedType` 解析后、类型分发前插 lens 分流（`resolvedType !== "diary"`，`lensChatType = (msg.threadId || resolvedType === "notification") ? "thread" : resolvedType`，绝不取 `notification`），命中即调 `handleLensMessage` 并 return。
6. `src/agent/tools/web_search.ts`：单工具，`execute` 里 `switch(provider)` 调 `searchTavily` / `searchBrave`，归一化成 `{ title, url, snippet, content? }[]`；新增对应 params schema 到 `src/agent/schemas.ts`。
7. `src/config.ts` 加 `knowledge.search` 解析（`provider: "tavily" | "brave"` + `apiKeyEnv`）；`data/setting.example.json` 补该段；`.env.example`（若无则新建）补 `TAVILY_API_KEY=` / `BRAVE_API_KEY=` 占位与注释。`web_search` 接入 `createKnowledgeTools`，但只有配置和对应 env key 都存在时才注册，并加入 dm/topic/thread 默认工具集。
8. 三段方法 prompt 常量（think 样板已定，rank/plain 按「核心判断 1」从对应 `SKILL.md` 提炼）。
9. `/help`（`commands.ts`）补三条命令说明；更新 `docs/commands.md`、`docs/persona.md`（lens 与 soul 的分层关系、lens 只读边界）、`docs/configuration.md`（搜索配置与 key）。

## 明确不做

- **产物渲染类 ljg skill（card / present / library / travel）**：需要 Playwright/HTML 模板 → PNG 管线，ROI 取决于是否真要「卡片产物」，本轮不碰。
- **阅读类（paper / book / read）**：读书助手是另一个产品方向；知识收藏已由 vault 覆盖。
- **learn / roundtable / relationship / writes / qa**：强格式全景报告 / 多人辩证 / 过度心理分析 / 长文 / Q-A 链，都与 soul 声音冲突或偏离思想伙伴定位。
- **通用 SKILL.md 加载引擎**：只接三个具体方法，不建「能加载任意 skill」的 registry/plugin 系统（违反单实现不抽象）。
- **per-group soul**：见「核心判断 2」。
- **新 chatType / route**：lens 复用现聊天流式 producer，只加一个瘦 `handleLensMessage` runner，不引入新 chatType 或 model route。
- **日记群 lens**：日记群不支持这三个命令（开发者明确不会在日记群用），lens 路由排除 diary。

## 评审重点

后续评审（GPT/Claude）时重点看：

- lens 命令是否真的没被 `handleCommand` 截成「未知命令」：`handleCommand` 对 lens 返回 `handled:false`，`main.ts` 在类型解析后分流到 `handleLensMessage`。
- lens 是否只读：`handleLensMessage` 不调 `promoteKnowledgeIfNeeded`；`/plain` 回复 Inbox 卡片后，卡片仍在原路径、frontmatter 未被命令文本污染。
- 工具状态是否不泄漏：lens 单轮 `setActiveTools` 后在 `finally` 恢复进入 lens 前从 harness 读取到的 `restoreToolNames`；同一 DM 先 `/think` 再普通聊天，第二轮仍能用进入 lens 前的工具集。
- 日记群是否排除 lens：`resolvedType === "diary"` 不进 lens 分流。
- 流式 producer 是否被提成共享 helper 复用，而不是第三次复制粘贴。
- lens 回复态是否只读取父消息正文，没有把 `buildReplyContext` 的 `[reply_to 原文]` / `--- 当前用户消息 ---` 脚手架塞进分析对象，也没有新开 chatType/route。
- `lensChatType` 是否绝不取 `notification`：通知群直接回复映射到 `thread`（合法 chatType），不为过编译新增 `notification` chatType。
- 对象解析是否严格三态：有 body 用 body、是回复用父消息、都没有就提示不生效。
- 声音是否仍只由 `soul.md` 管，方法 prompt 是否只含思考动作、没有重复声音规则、没有把 ljg 的 org-mode/ASCII/denote 输出机械带进来。
- 是否没有引入 per-group soul，没有改动 layer 1 人格内核。
- `web_search` 是否一个工具 + 一个 `switch`，没有长出 provider 抽象层；归一化形状是否两个 provider 都装得下；配置和 key 缺失时是否不注册、不暴露该工具。
- plain 的 URL 路径是否仍走 `fetch_article`，没有用搜索重复实现抓取。
- 三个 lens 之外是否没有顺手接入产物类/阅读类/通用 loader（范围蔓延）。
