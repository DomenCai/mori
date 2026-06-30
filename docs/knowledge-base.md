# 知识库

知识库是 mori 的 vault：它是 Markdown 文件存储，智能发生在读取和综合时。写入侧只抓取、落盘和去重，不在入库时跑 LLM 做 digest、标签或知识地图。

## 文件位置

生产态在 `~/.mori/vault/`，开发态在 `data/vault/`。

```text
vault/
  notes/YYYY-MM/<slug>.md
  reviews/YYYY-Www.md
```

`notes/` 存收藏群、`/save` 对话和手动保存内容；`reviews/` 存每周收藏周报。旧的 `Inbox/`、`Garden/`、`.index.md` 不再由新代码读写。

## Frontmatter

创建文件时只写最小字段：

```yaml
---
title: 标题
source_type: clip # clip | conversation | review | manual
source_url: https://example.com
origin_note: 用户原始消息或 /save 备注
saved_at: 2026-06-20T00:00:00.000Z
period: 2026-W26
covers:
  - notes/2026-06/example.md
---
```

缺省字段不写。正文就是原始抓取内容、过滤后的对话 markdown 或周报正文。

## 入库方式

| 方式 | 结果 |
|---|---|
| 收藏群顶楼发纯 URL | 抓取正文，写入 `notes/YYYY-MM/`，反馈卡带 `knowledge_path` |
| 收藏群顶楼发文本或 URL+评论 | 直接把文本作为正文写入 `notes/YYYY-MM/` |
| 任意受管会话发 `/clip <纯 URL>` | 抓取正文并收藏 |
| 任意受管会话发 `/clip <文本或 URL+评论>` | 直接收藏这段文本并回反馈卡 |
| 回复一条通知发送 `/clip` | 把被回复的通知内容收藏到 `notes/YYYY-MM/` |
| DM / 主题群 / clip thread 发 `/save [备注]` | 保存当前 session segment 内最近 60 条 user/assistant 文本 |
| 用户明确要求 agent 收藏 | agent 可 `fetch_article` 后调用 `vault_save` |
| 收藏周报 cron | 每周生成 `reviews/YYYY-Www.md`，并把最新一期推到通知群 |

相同 URL 会做轻量 canonicalization 后去重：去 fragment、尾斜杠和 `utm_*` 参数。

## 知识工具

普通对话、主题群和 thread 默认可用：

| 工具 | 作用 |
|---|---|
| `fetch_article(url)` | 抓取 URL 为 markdown；飞书文档走 SDK，其它走 defuddle |
| `vault_save(...)` | 新增保存 clip/manual 笔记，不允许覆写路径 |
| `vault_search(query, k?)` | 用 `rg` 检索 vault；空 query 返回最近笔记 |
| `vault_read(path)` | 读取单个 vault Markdown 文件全文 |

删除、更新、promote 不在工具内。用户要删改文件时，直接在 vault 目录或 Obsidian 里处理。

## 查询与周报

system prompt 不再注入知识地图。agent 根据 `knowledge_policy.md` 在查询时主动 `vault_search` / `vault_read`，跨多条笔记综合共识、分歧和时间线。

`weekly_review` builtin 每周一 08:00 检查已结束且有新增的 ISO 周；缺口按最旧到最新补，最多 4 周。周报本身写回 `reviews/`，下一期会读取最近 1-2 期周报做承接。
