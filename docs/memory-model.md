# 记忆模型

这份文档说明 mori 怎么"了解你"：五层记忆各自存什么、谁能写、什么时候写。可编辑的策略原文在仓库根的 [`agent/memory_policy.md`](../agent/memory_policy.md)，这里讲背后的设计取舍。

## 五层记忆

| 层 | 存什么 | 注入时机 | 存储 |
|---|---|---|---|
| ① 身份画像 | 稳定的"我"：价值观、好奇心方向、判断习惯、表达风格、稳定关系 | 始终注入 | `profile` + `memory/profile.md` |
| ② 当前主线 | 横跨多条 storyline 的当前阶段、主题或反复卡点 | 非空时始终注入 | `chapter` / `chapter_revisions` + `memory/chapter.md` |
| ③ Storylines | 用户生活里正在展开的叙事线：项目、关系、情绪弧线、持续兴趣、身份变化、未闭环的事 | active 全量注入；chapter 非空时 recent dormant 只注入 2 条 compact 摘要 | `storylines` / `storyline_revisions` |
| ④ Fresh episodes | 尚未被 `daily_memory` 消化的少量新 episode 摘要 | 临时注入 | `episodes` |
| ⑤ 原文 + episode 归档 | 完整原始消息和带证据观察 | 不注入，按需 `search_memory` 检索 | `messages` / `episodes` |

越往上越稳定、越浓缩；越往下越原始、越易变。"了解你"的核心不只是画像，而是画像 + 当前主线 + storylines：既知道"你是谁"，也知道"你正处在哪一章"，以及"你生活里哪些线正在展开"。

## episode：证据层，不做长期叙事

每段日记、知识卡反应、会话片段都蒸馏成一条 episode：

```ts
{
  brief: string;
  observations: Array<{
    text: string;
    evidence: string;
    tag?: string;
  }>;
}
```

episode 是检索索引和观察索引，不承担跨天叙事维护，也不预先替周合并给画像下结论。跨 episode 的连续变化由 `daily_memory` 合并进 storylines。

## 当前主线：跨线连接层

`chapter` 是 profile 与 storylines 之间的一段短 prose。它不复述 active storylines，而是写这些线背后共同指向的阶段、主题或反复卡点。

写入只发生在 `weekly_consolidation` 的机械轮里，并且每次变更都写 `chapter_revisions`。主证据字段是 `source_storyline_ids_json`，`source_episode_ids_json` 只作为可选原文锚点。chapter 初始为空，非空后会在系统 prompt 中插在身份画像和 active storylines 之间。

chapter 只用于把握总体阶段。具体回应某个项目、关系或状态时，仍以对应 active storyline 为准；核对事实时回到 storylines、fresh episodes 或 `search_memory` 检索 episode / 原文。chapter 非空后，recent dormant storylines 的常驻注入会从 5 条完整形态收紧为 2 条 compact 摘要，避免旧线压过当前主线。

chapter 的红线比普通 storyline 更严：它只能描述处境与主题，不下心理状态、人格、关系或健康结论。月度即过期的工具判断、战术偏好或阶段性做法也不再写入 profile；阶段性主线归 chapter，可复用知识归 vault，都不算就不写。

`memory/profile.md` 和 `memory/chapter.md` 是可编辑外部界面。程序更新画像或主线时会同时写 DB 和文件；用户手动改文件后，下一个新 session 会读取文件，同步回 DB，并记录一条 `manual_file_edit` 修订。已有热 session 不会中途重载。

## storylines：中间叙事层

`storylines` 取代旧 `working_items`。它不是项目管理表，不记录 decisions/next_steps，而是记录：

- 这条线是什么：`kind` / `title` / `summary`
- 当前张力：`current_tension`
- 态度或情绪如何变化：`emotional_arc`
- 相关人：`people`
- 证据：`evidence_episode_ids`
- 状态：`active` / `dormant` / `closed`

写入只发生在 `daily_memory` 的 dream_agent 里，并且每次变更都写 `storyline_revisions`。`advance_storyline` 的 schema 不允许修改 `title` / `kind`，避免模型每天重命名同一条线。

## daily_memory：每日压缩回路

`daily_memory` 每天 06:00（按 `setting.time.timezone`）处理前一业务自然日，不补跑。它先做机械逻辑，再跑两个窄 agent：

1. 机械收缩：无条件执行。active storyline 超过 21 天未活跃转 dormant；active 超过 12 条时，按最久未活跃优先转 dormant。
2. dream_agent：有 fresh episodes 时，把新信号合并进 storylines。
3. nudge_agent：连续沉默达到阈值时，判断是否轻触达。
4. 审计：所有结果写入同一条 `daily_memory_runs`。

nudge 有代码层硬闸：连续沉默少于 3 天不评估；距上次实际 `send_checkin` 不足 7 天，当天不运行 nudge_agent。prompt 仍要求默认不发，避免把陪伴变成打卡。

## weekly_consolidation：写画像和当前主线

周合并不再更新 storylines。它读取本周 `daily_memory_runs`、touched storylines、当前 visible storylines 和 episode evidence，只判断是否需要更新长期 `profile` 或刷新 `chapter`，并生成两张卡片：

- 卡片 1「这周」：客观记录 + 叙事线索变化 + 画像变更
- 卡片 2「朋友的话」：纯散文，best-effort，失败不影响已落库的记录

画像变更必须能追到用户证据。周合并回读 episode 原文时只把 `user:` 内容作为画像证据，避免 Agent 把自己曾经说过的话再当作用户事实。当前 visible storylines 只供刷新 chapter 使用，不能放宽画像门控。

## 写权限

| 路径 | 实时写 | 画像 / 当前主线 |
|---|---|---|
| 日记群 | episode | ❌ 走周合并 |
| 通知群回复知识卡 | episode、promote 知识卡 | ❌ 走周合并 |
| DM / 话题 / 子话题 | 关闭时蒸馏 episode | ❌ 走周合并 |
| daily_memory | storylines、daily run 审计、可选 send_checkin | ❌ |
| 周合并 | weekly summary、**画像**、**当前主线** | ✅ 唯一自动写画像和当前主线路径 |
| `/profile` 命令 | — | ✅ 显式手动纠正画像 |

所有热会话都不直接写画像或当前主线；所有画像变更都汇到周合并或显式 `/profile`，当前主线只由周合并自动维护。
