# 定时任务

定时任务分两类：框架内置的 builtin，以及用户写的 script。配置文件是 `schedules.json`，路径见 [配置参考](configuration.md)。cron 统一按 `setting.time.timezone` 解释。

## 默认 builtin

内置任务基线写在 `src/schedule/config.ts`，代码是权威；`schedules.json` 只覆盖字段。

| id | builtin | 默认触发 | 做什么 |
|---|---|---|---|
| `weekly-summary` | `weekly_summary` | `55 23 * * 0` | 运行周度合并，更新画像、写周总结并发卡 |
| `daily-memory` | `daily_memory` | `0 6 * * *` | 处理前一业务自然日的 fresh episodes，维护 storylines，必要时轻触达 |
| `knowledge-index` | `knowledge_index` | 内容量触发 | 刷新 `vault/.index.md` 知识地图 |

## schedules.json 覆盖层

只需要写要覆盖的字段：

```jsonc
{
  "schedules": [
    { "id": "daily-memory", "enabled": false },
    { "id": "weekly-summary", "cron": "0 22 * * 0" }
  ]
}
```

- 命中内置 `id`：只覆盖 JSON 里写到的字段。
- 代码不认识的 builtin：忽略。
- script 任务：JSON 是唯一来源。
- `/schedules` 卡片按钮只写启停覆盖，不落盘完整默认配置。

## Script 任务

script 任务用于定时投喂知识内容。脚本放在 `scriptDir` 下：生产态 `~/.personal-agent/script/`，开发态 `data/script/`。

示例：

```jsonc
{
  "schedules": [
    {
      "id": "ai-daily",
      "name": "AI 日报",
      "kind": "script",
      "script": "ai-daily.mjs",
      "cron": "0 8 * * *",
      "enabled": true,
      "runtime": {
        "timeoutMs": 180000,
        "resourceLimits": {
          "maxOldGenerationSizeMb": 256,
          "maxYoungGenerationSizeMb": 64
        }
      },
      "deliver": { "notify": true, "inbox": "AI日报" }
    }
  ]
}
```

脚本必须是 `.mjs`，并 default export 一个函数：

```js
export default async function run() {
  return {
    title: "今日 AI 要闻",
    domain: "AI",
    tags: ["news"],
    brief: "三条值得看的进展",
    body: "# 今日 AI 要闻\n\n...",
    source_url: "https://example.com"
  };
}
```

必填字段是 `title`、`domain`、`brief`、`body`；`tags` 必须是数组；`source_url` 可选。

## Script 执行边界

- script 在 `worker_threads` 里运行，默认 timeout 和 JS heap 限制来自 `setting.script.defaults`。
- 单个 script schedule 可以用 `runtime.timeoutMs` 和 `runtime.resourceLimits` 覆盖默认值。
- worker 不是安全沙箱，但能隔离常见错误、异常和 CPU 卡死。
- script 不直接碰飞书、不直接碰数据库；它只返回结构化文章。
- 框架负责写 Inbox、发通知群、保存通知群 assistant message。
- 投递文件名使用确定性 slug：`<schedule.id>-<run-window>`。同一窗口文件已存在时跳过，不重复发卡。

## 投递与通知群

script 成功返回后：

1. 框架写入 `vault/Inbox/<deliver.inbox>/YYYY-MM/<slug>.md`。
2. 如果 `deliver.notify` 为 `true`，创建或复用“Personal Agent 通知”群。
3. 发送知识卡片，并把 `pushed_message_id` 写进 frontmatter。
4. 把 assistant 通知消息写入 `messages`，用于后续 reply 反查知识文件。

用户如何回复知识卡，见 [知识库](knowledge-base.md)。

## Knowledge index 触发

`knowledge-index` 没有 cron 时也会被后台按 `setting.knowledge.index.checkIntervalMs` 检查一次。默认 trigger：

```jsonc
{ "type": "volume", "n": 5, "days": 3 }
```

满足以下任一条件会刷新：

- `vault/.index.md` 不存在且 vault 有知识文件。
- 自上次 index 以来新增或修改的知识文件数大于等于 `n`。
- 有新内容，并且 index 已超过 `days` 天未刷新。

如果 LLM 版 knowledge index 没产出正文，任务会报错；代码里还有 deterministic index helper，但当前 builtin 入口使用 harness 生成。
