# Design Index

> `design/` 按 `YYYYMMDD-slug/` 组织。每个目录代表一轮设计或一个功能主题，目录内的 `index.md` 是入口；顶层 `index.md` 只负责导航、状态和阅读优先级。

## 目录规则

- 新设计放在 `design/YYYYMMDD-slug/` 下，例如 `design/20260620-storyline-memory-redesign/`。
- 一个功能主题的需求、方案、拆分设计、审核重点都放在同一个日期目录里。
- 目录内必须有 `index.md`，说明背景、文档清单、当前状态和被替代关系。
- dated design 是设计历史；当前事实优先看 `README.md`、`docs/` 和代码。
- dated design 互相冲突时，默认较新的日期优先；若是旧文档中的局部设计被新文档替代，必须在两个目录的 index 里标明。

## 当前设计目录

| 日期 | 目录 | 状态 | 内容 |
|---|---|---|---|
| 2026-06-29 | [`20260629-agent-class-refactor`](20260629-agent-class-refactor/index.md) | 已实现 | `src/agent/harness.ts` 已拆为 `AgentService`、`HarnessFactory`、`AgentRuntime`、`BaseAgent` / `OneShotAgent` 和 `src/agent/agents/*`；`runForStream` / `runForFinalText` / `runForSideEffect` / `runForToolResult` 收敛一次性 agent 的结果提取；dm/topic/thread 走 `ChatAgent`，diary 走 `DiaryAgent`；distill/consolidation/daily_memory/schedule/weekly_review 运行形态进入 agent 类，业务编排仍留在 `src/diary/*`、`src/memory/*`、`src/schedule/*`；画像编辑权限由 `toolGroups: ["profile_edit"]` 声明。 |
| 2026-06-29 | [`20260629-vault-refactor`](20260629-vault-refactor/index.md) | 已实现 | 知识库最终实现为哑存储 + 智能消费者：砍 Inbox/Garden、`.index.md` 常驻 prompt、promote/update 类工具和 KnowledgeIndexAgent；新增唯一收藏群 `clip`、`/clip`、`/save`、`knowledge_policy.md`、`WeeklyReviewAgent` + `weekly_review` cron；vault 写入 `notes/YYYY-MM/` 与 `reviews/YYYY-Www.md`；工具收敛为 `fetch_article` / `vault_save` / `vault_search` / `vault_read`；不做写入时 digest、tags、FTS 或用户 vault 数据迁移。替代 `20260619-mvp-to-north-star` 中的知识库章节。 |
| 2026-06-28 | [`20260628-session-resume-and-system-refresh`](20260628-session-resume-and-system-refresh/index.md) | 已实现 | 定义会话恢复与 system prompt 刷新：SQLite session/message 索引、JSONL transcript 恢复、reply_to 冷启动恢复规则、topic 长寿命会话、idle/new 边界、每轮刷新但保持 prompt 确定性。当前实现见 `docs/sessions.md`、`src/agent/service.ts`、`src/agent/sessions.ts`。 |
| 2026-06-22 | [`20260622-memory-chapter-layer`](20260622-memory-chapter-layer/index.md) | 已实现 | 在 profile 与 storylines 之间补「当前主线」(chapter) 层：常驻注入、weekly 重写、带 chapter_revisions 审计，给跨线纵向洞察一个会被重新注入的家。weekly mechanical 轮在画像门控之外加 set_chapter，靠输入分区防止 standing state 松动画像；Stage 1 不触碰任何已有用户数据，profile 卫生只立今后规则。 |
| 2026-06-22 | [`20260622-cognitive-lenses`](20260622-cognitive-lenses/index.md) | 已实现 | 把 ljg-skills 的 think/rank/plain 三个认知方法以斜杠命令形态接入：提炼方法骨架、声音归 soul（一个 soul 不按群分人格），回复态复用父消息取数来源但只取正文；`web_search` 在配置和 key 都存在时启用。 |
| 2026-06-21 | [`20260621-runtime-setting-final-form`](20260621-runtime-setting-final-form/index.md) | 已实现 | 定义 `setting.json` / `lark_config.json` / `schedules.json` 边界，把 LLM provider、时区、会话策略、script timeout、HTTP 抓取和知识搜索配置纳入最终配置方案；当前事实见 `docs/configuration.md`。 |
| 2026-06-20 | [`20260620-input-adapters-and-backfill`](20260620-input-adapters-and-backfill/index.md) | 多入口输入与历史回放设计 | 定义多来源内部 message、完整 scope 与飞书 thread 保留、日记蒸馏核心、模拟时钟，以及历史日记 backfill。 |
| 2026-06-20 | [`20260620-storyline-memory-redesign`](20260620-storyline-memory-redesign/index.md) | 当前记忆层基线 | 用 `storylines` 取代 `working_items`，新增 `daily_memory`，删除记忆审批，重设 weekly consolidation。 |
| 2026-06-19 | [`20260619-mvp-to-north-star`](20260619-mvp-to-north-star/index.md) | 北极星蓝图；记忆层部分已被 2026-06-20 修正 | 从 MVP 走向北极星功能的存储、知识库、定时任务、会话 scope，以及旧工作集审批方向。 |

## 阅读顺序

1. 看知识库重构（收藏群入口、`/clip`、`/save`、weekly review、工具集收敛、knowledge_policy）：读 [`20260629-vault-refactor`](20260629-vault-refactor/index.md)。
2. 看会话恢复、reply_to 冷启动恢复、topic 长寿命会话和 system prompt 刷新：读 [`20260628-session-resume-and-system-refresh`](20260628-session-resume-and-system-refresh/index.md)。
3. 看思考透镜（think/rank/plain 斜杠命令）、lens 与 soul 的分层、web_search 接入：读 [`20260622-cognitive-lenses`](20260622-cognitive-lenses/index.md)。
4. 看运行配置最终边界、LLM provider、时区、会话策略、script timeout、HTTP 抓取和知识搜索配置：先读 [`20260621-runtime-setting-final-form`](20260621-runtime-setting-final-form/index.md)。
5. 看当前记忆模型、daily memory、weekly consolidation：读 [`20260620-storyline-memory-redesign`](20260620-storyline-memory-redesign/index.md)；其上新补的「当前主线」(chapter) 层见 [`20260622-memory-chapter-layer`](20260622-memory-chapter-layer/index.md)。
6. 看历史日记导入、桌面端接入、多入口输入边界：读 [`20260620-input-adapters-and-backfill`](20260620-input-adapters-and-backfill/index.md)。
7. 看存储、知识库、脚本投喂、会话 scope：读 [`20260619-mvp-to-north-star`](20260619-mvp-to-north-star/index.md)；其中知识库章节已被 `20260629-vault-refactor` 替代。
8. 读到 `working_items` / 工作集审批相关内容时，按历史方案处理；当前实现方向以 `storylines` 为准。
