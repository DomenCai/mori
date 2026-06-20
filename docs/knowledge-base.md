# 知识库

知识库是 Personal Agent 的 vault：Agent 可以把用户明确收藏的内容、定时投喂的文章和用户对知识卡片的反应沉淀成 Markdown 文件。它不是任务执行平台，而是“关于世界的资料库”和“关于用户兴趣的反馈回路”。

## 文件位置

生产态在 `~/.personal-agent/vault/`，开发态在 `data/vault/`。

```
vault/
  Inbox/<任务名>/YYYY-MM/<slug>.md
  Garden/YYYY-MM/<slug>.md
  .index.md
```

| 区域 | 用途 |
|---|---|
| `Inbox/` | script 定时投喂的候选内容，等待用户反应 |
| `Garden/` | 用户主动收藏，或从 Inbox 晋升后的 kept 内容 |
| `.index.md` | knowledge index builtin 生成的知识地图 |

vault 文件必须有 YAML frontmatter；正文创建后 Agent 不做就地编辑。

## Frontmatter

创建文件时会写入：

```yaml
---
title: 标题
domain: AI
tags:
  - agent
brief: 一句话摘要
status: inbox # inbox | kept
source_url: https://example.com
saved_at: 2026-06-20T00:00:00.000Z
---
```

用户对知识卡片产生反应后，会追加或更新：

```yaml
status: kept
reacted_at: 2026-06-20T00:00:00.000Z
my_note: 用户回复里的看法
pushed_message_id: om_xxx
```

## 入库方式

| 方式 | 结果 |
|---|---|
| 用户明确要求收藏 URL | Agent 可调用 `fetch_article` 抓正文，再 `save_to_garden` 直接写入 `Garden/YYYY-MM/` |
| script 定时任务产出文章 | 框架写入 `Inbox/<任务名>/YYYY-MM/`，可选发到通知群 |
| 用户普通回复通知群知识卡 | 对应 Inbox 文件被 `promote` 到 Garden，frontmatter 记录 `my_note`，并写一条 reaction episode |
| 用户话题回复通知群知识卡 | 文件先晋升到 Garden；thread 内可深聊，thread 关闭时蒸馏这段讨论 |

第一版只支持 URL 文章抓取和 script 返回结构化文章；零散文本收藏没有单独入口。

## 知识工具

普通对话、主题群和 thread 默认可用知识工具：

| 工具 | 作用 |
|---|---|
| `fetch_article(url)` | 抓取 URL 并清洗成 Markdown 文章 |
| `save_to_garden(...)` | 把用户明确收藏的内容保存到 Garden |
| `grep_vault(query, scope?)` | 用 `rg` 检索 vault；无 `rg` 时走内置 fallback |
| `read_vault(path)` | 读取单个 vault Markdown 文件全文 |
| `update_frontmatter(path, frontmatter_json)` | 只更新 frontmatter，不改正文 |
| `promote(path, my_note?)` | 把 Inbox 文件移动到 Garden，并记录用户看法 |

知识工具的路径参数都是 vault 相对路径，并有越界检查。

## 知识地图

`knowledge_index` builtin 维护 `vault/.index.md`。它读取 vault 文件的 path + frontmatter，生成压缩地图，让 Agent 知道 vault 里大概有什么。

触发规则见 [定时任务](schedules.md)：默认新增内容达到阈值，或 index 有新内容且超过阈值天数，就刷新。session 开始时会把当前 `.index.md` 注入快照；session 中途新增的文章仍可被 `grep_vault` 命中，但不一定已经出现在地图里。

## 通知群反馈回路

script 投喂会创建或复用“Personal Agent 通知”群。通知卡片包含标题、领域、标签、vault 路径和摘要。

- 普通回复：快速收藏和记录看法，不展开长对话。
- 话题回复：进入飞书 thread 深聊，thread 是独立 scope。
- 无关联知识卡的普通通知群消息会被忽略并提示。

知识反应只写 episode，不直接写身份画像；画像仍由周度合并或 `/profile` 手动纠错维护。
