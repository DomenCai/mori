# 北极星设计总览（Index）

> Personal Context Agent 的 **post-MVP 北极星**设计索引。本目录下 5 份文档共同定义"懂我 + 知识库"双支柱的目标架构。
> 旧的 MVP 需求/实施文档已废弃,**以本目录文档为准**。基线即当前代码。

---

## 1. 北极星一句话

一个**飞书优先的对话型个人 Agent**,有两根咬合的支柱:

- **支柱 A · 懂我**:记忆系统(身份画像 / 工作集 / episode),理解"我是谁、在做什么"。
- **支柱 B · 知识库**:Agent 拥有的 vault(Obsidian 仓库),为成为 **T 型通才**服务——广度铺多领域 + 本领域深挖。

**咬合点**:知识库不是"执行平台",而是第二个输入源 + 第二个反馈回路——我对知识的反应本身就是关于"我"的高质量信号,反哺支柱 A。**所有聊天、所有反应,都让 Agent 更懂我。**

---

## 2. 当前基线(已实现,供审核者了解)

无需读旧文档,现有代码已具备:

- 日记群完整链路:日记入库 → 流式卡片回复 → `write_episode`(`turn_end` 兜底)。
- 四层记忆:身份画像(prose,单条)/ 工作集(`working_items`)/ episode / 原文+FTS。
- 周度合并 sub-agent(`consolidation.ts`):读本周 episode → 更新工作集 + 保守动画像 → 发周总结。
- 记日记提醒(纯代码)。
- 斜杠命令:`/new-diary-group` `/new` `/compact` `/profile` `/working` `/consolidate`。
- 飞书 channel(`@larksuite/channel` WS 长连接)、`AgentHarness` 封装、`config.chatBindings` 群绑定。
- 模型路由(`companion` / `weekly`)、SQLite + JSONL session。

> 一份独立的、**尚未实现**的设计也已在本目录:`working-item-tools-and-approval.md`。

---

## 3. 五份文档

| 文档 | 干什么 |
|---|---|
| **`storage-architecture.md`** | 地基。统一存储原则(可变即结构化、正文一次写定)、三层判据、`messages` 基建表、vault 布局、日记→messages 重构、SQLite 表去留。 |
| **`knowledge-base.md`** | 支柱 B。vault + Inbox/Garden、甲/乙两类入库、反应=晋升+反馈回路、主动 grep 检索、知识地图 index builtin、知识工具集。 |
| **`scheduled-tasks.md`** | 定时任务框架。builtin 进程内 / script worker 隔离、`schedules.json`、配置驱动投递、通知群、脚本返回契约。 |
| **`conversation-scopes.md`** | 会话生命周期。chat 类型、话题 vs 主题群、`sessionPolicy` 自动关闭、scope 边界蒸馏 episode、通知群反应、reply 注入。 |
| **`working-item-tools-and-approval.md`** | (已有,未实现)工作集工具拆分 `create/update/merge` + 审批卡片机制。 |

---

## 4. 依赖关系:什么必须串行,什么可并行

```
            ┌─────────────────────────┐
            │ storage-architecture     │  ← 地基，必须最先做
            │ (messages / vault /      │     具体:messages 表、日记→messages、
            │  日记重构 / config)       │     vault 目录、config.sessionPolicy、删 schedules 表
            └───────────┬─────────────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                 │
┌───────────────┐ ┌──────────────────┐    │
│ scheduled-    │ │ conversation-     │    │  这两份依赖地基，彼此可并行
│ tasks         │ │ scopes            │    │
└───────┬───────┘ └─────────┬────────┘    │
        │                   │             │
        └─────────┬─────────┘             │
                  ▼                       │
          ┌───────────────┐               │
          │ knowledge-base │  ← 整合前两者(乙类投喂来自 scheduled-tasks，
          │                │     反应/话题来自 conversation-scopes)，最后做
          └───────────────┘               │
                                          │
   ┌──────────────────────────────────────┘
   ▼
┌────────────────────────────┐
│ working-item-tools-approval │  ← 与上面整条链路独立，可全程并行
│ (只动 working_items + 审批表) │
└────────────────────────────┘
```

实施建议:

1. **先做 `storage-architecture`**(尤其 `messages` 表 + 日记→messages 重构),它会动到已测的 Phase-1 日记代码,且是其余一切的前提。
2. 之后 **`scheduled-tasks` 与 `conversation-scopes` 可并行**(都只依赖地基)。注:`scheduled-tasks` 的投递还用到 `knowledge-base` 的 **frontmatter 字段契约 + Inbox 语义**(vault 路径、`messages.knowledge_path` 已在地基里);该契约小而稳,先把 frontmatter 字段表冻结即可并行,不必等整份 `knowledge-base` 做完。
3. **`knowledge-base` 最后做**(它整合投喂与反应/话题)。
4. **`working-item-tools-and-approval` 全程可独立并行**(只触碰工作集表 + 新审批表,与知识/vault/话题无耦合)。

---

## 5. 给审核者(GPT)的重点关注项

### 跨文档一致性
- 工作集工具一律用 `create/update/merge`,**不得出现 `upsert_working_item`**(本轮与 `working-item` 文档对齐)。
- "高影响写入→审批卡片"模式只用于工作集 merge / 周总结批量改;**知识反应/晋升是低风险单条操作,不进审批**——确认这条边界合理。

### 存储架构
- 三层判据的分界线是否划对?**日记不再单独存 markdown、原文只进 `messages`**——确认接受;`search_diary` 退化为"主要搜 episodes_fts、单条消息 episode 按 message_id 回表、scope episode 按来源时间窗回表"是否可接受(失去原始逐字全文检索)。
- `messages` 无差别存所有正文(含日记),与 episode 引用形成的弱重复——确认"基建层不耦合业务"这个取舍优于"消重但耦合"。
- 日记→messages **不迁移,清库重来**(现有都是测试数据);真实历史导入是后续单独的一次性脚本,不在本轮。
- 删 `schedules` 表零数据迁移成本,确认。

### 定时任务
- **script 隔离**(已定):builtin 进程内,**script 走 `worker_threads`**——设置 `resourceLimits` + 超时 `terminate()` 强杀(含 CPU 死循环)、未捕获异常不退主进程,满足"坏脚本不拖垮 daemon"。原"必须进程内才够得着连接"理由只适用 builtin(script 纯数据、不碰飞书)。
- **frontmatter 合法性**(已定):框架用 **YAML serializer** 渲染(非字符串拼接),冒号/换行/中文都正确转义,合法性由 serializer 保证。
- **script 幂等**(已定):确定性 slug(`<schedule.id>-<run-window>`)→ 文件已存在则跳过投递,零运行时状态、不建 `schedule_runs` 表。
- builtin 三类幂等靠现有领域数据推导(周总结 `week_key`、提醒查 `messages` 最后时间、index 看文件 mtime)——确认无遗漏触发竞态。

### 会话 scope
- **episode-on-close 必须靠定时扫描触发**(非懒判定),否则临时话题聊完即弃永不蒸馏——确认扫描机制覆盖。
- scope key 扩成 `chatId:threadId` 后无碰撞。
- 不开 `resolveChatMode`,仅靠 `chatBindings` + `threadId` 能否正确路由所有消息(尤其通知群里的话题)。
- "所有对话 scope 边界蒸馏 episode" 会显著增加 episode 量与 LLM 调用——确认成本可接受、且不污染记忆信噪比。

### 全局
- system prompt 总预算:记忆快照 + 知识地图(<3000 token)合计是否可控。
- 红线:反应/对话蒸馏**永不写身份画像**,在机制(激活工具集 + `tool_call` 拦截)上是否真的锁死。
