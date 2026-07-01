# 定时任务

定时任务配置文件是 `schedules.json`，路径见 [配置参考](configuration.md)。cron 统一按 `setting.time.timezone` 解释。

## 任务类型

mori 目前有三类 schedule：

| kind | 用途 | 执行边界 |
|---|---|---|
| `builtin` | 框架内置任务 | 代码固定 |
| `script` | 纯脚本抓取、整理、投递 | worker 线程运行 `.mjs` |
| `agent` | 定时跑一次 mori agent | 主线程运行，可用 inline prompt 或 task script |

## 默认 builtin

内置任务基线写在 `src/schedule/config.ts`，代码是权威；`schedules.json` 只覆盖字段。

| id | builtin | 默认触发 | 做什么 |
|---|---|---|---|
| `weekly-summary` | `weekly_summary` | `55 23 * * 0` | 运行周度合并，更新画像、写周总结并发卡 |
| `daily-memory` | `daily_memory` | `0 6 * * *` | 处理前一业务自然日的 fresh episodes，维护 storylines，必要时轻触达 |
| `weekly-review` | `weekly_review` | `0 8 * * 1` | 为已结束且有新增收藏的 ISO 周生成收藏周报 |

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
- `script` / `agent` 用户任务：JSON 是唯一来源。
- `/schedules` 卡片按钮只写启停覆盖，不落盘完整默认配置。

## ScheduleResult 与投递

用户任务最终返回 `ScheduleResult`：

```ts
type ScheduleResult =
  | null
  | undefined
  | string
  | {
      title?: string;
      body: string;
      domain?: string;
      brief?: string;
      tags?: string[];
      source_url?: string;
    };
```

- `null` / `undefined`：本窗口无投递。
- `string`：等价于 `{ body: string }`。
- 只要求 `body`，标题默认用 schedule name。
- `deliver.notify:true`：推送飞书通知话题群；默认使用 `mori 通知`，首次投递会自动创建原生 topic chat。
- `deliver.notifyChat`：可选通知群名称；配置后按该名称在 notification 群绑定里查找，找不到就新建同名通知群。不配置时走默认通知群，默认群用本地 `isDefault` 标记识别，不依赖群名。
- `deliver.inbox`：历史字段，当前保留兼容但不写入 vault。
- 通知投递使用普通 markdown 消息。要围绕通知继续聊，在通知话题里创建话题；要收藏通知内容，回复该通知发送 `/clip`。
- 不 notify：允许静默运行。

## Script 任务

script 任务用于纯脚本抓取和整理。脚本放在 `scriptDir` 下：生产态 `~/.mori/script/`，开发态 `data/script/`。

```jsonc
{
  "schedules": [
    {
      "id": "ai-daily",
      "name": "AI 日报",
      "kind": "script",
      "script": "ai-daily.mjs",
      "cron": "0 9 * * *",
      "enabled": true,
      "deliver": { "notify": true, "notifyChat": "AI 日报" }
    }
  ]
}
```

脚本必须是 `.mjs`，并 default export 一个函数：

```js
export default async function run() {
  return {
    title: "今日 AI 要闻",
    body: "# 今日 AI 要闻\n\n..."
  };
}
```

## Agent Inline 任务

inline agent 用于简单提醒或简单定时问答：

```jsonc
{
  "schedules": [
    {
      "id": "diary-reminder",
      "name": "日记提醒",
      "kind": "agent",
      "prompt": "根据最近记忆，提醒我今天可以记录什么日记。",
      "profile": "normal",
      "system": "mori",
      "tools": ["search_memory"],
      "cron": "0 22 * * *",
      "deliver": { "notify": true },
      "enabled": true
    }
  ]
}
```

- `profile` 可选，填 `setting.llm.model_profiles` 里的档位名，例如 `"normal"` / `"strong"`；不填或档位不存在时回退 `"normal"`。
- `system` 默认 `"bare"`；`"mori"` 会注入 mori 的用户信息/记忆 system prompt；也可以填自定义 system prompt。
- `tools` 只能写内置工具名，不传即不开工具。
- 通知标题使用 schedule name，正文使用 agent 最终输出。

## Agent Task Script

复杂 agent 任务用 `.mjs` 返回 task spec。框架在主线程加载脚本，把脚本返回的本地工具接入一次性 agent run。

```jsonc
{
  "schedules": [
    {
      "id": "aihot-selected",
      "name": "AI 精选动态",
      "kind": "agent",
      "script": "aihot-selected-agent.mjs",
      "profile": "strong",
      "cron": "0 */4 * * *",
      "deliver": { "notify": true, "notifyChat": "AI 精选" },
      "enabled": true
    }
  ]
}
```

脚本示例：

```js
export default async function ({ Type }) {
  const items = await fetchItems();
  let selectedIds = [];

  return {
    system: "bare",
    prompt: `请从候选内容里选出最值得看的 10 条，只能调用 select_items 工具提交选择。\n\n${JSON.stringify(items)}`,
    tools: [
      {
        name: "select_items",
        label: "选择精选日报",
        description: "提交最终选中的日报 ID。",
        parameters: Type.Object({
          ids: Type.Array(Type.String()),
        }),
        execute: async (_id, params) => {
          selectedIds = params.ids;
          return {
            content: [{ type: "text", text: `已选择 ${params.ids.length} 条` }],
            details: { ids: params.ids },
          };
        },
      },
    ],
    result: async ({ text }) => {
      const selected = items.filter((item) => selectedIds.includes(item.id));
      return {
        title: "AI 精选日报",
        domain: "AI",
        brief: `精选 ${selected.length} 条 AI 动态`,
        tags: ["AI", "精选"],
        body: renderSelected(selected, text),
      };
    },
  };
}
```

Task spec 字段：

- `prompt`：必填，本次 agent 任务 prompt。
- `system`：可选，默认 `"bare"`；支持 `"mori"` 或自定义 system prompt。
- `tools`：可选，可混用内置工具名和 pi-agent-core `AgentTool` 对象。
- `result`：可选，接收 `{ text }`，返回 `ScheduleResult`；不填则默认 `{ body: text }`。

自定义工具名不能与内置工具名冲突。

## 执行边界

- `script` 在 `worker_threads` 里运行，默认 timeout 和 JS heap 限制来自 `setting.script.defaults`。
- `agent` 在主线程运行，能接入 mori harness、system prompt、内置工具和 task script 自定义工具。
- 单个 `script` / `agent` schedule 都可以用 `runtime.timeoutMs` 覆盖默认 timeout。
- `agent` 超时使用 `Promise.race`，不会强杀底层 LLM 请求或工具调用。
- 只通知不入库时没有框架层文件去重；需要去重的任务应由脚本自存 state。

## 收藏周报补偿

`weekly_review` 是普通 cron builtin。每次运行时会计算“有新增笔记且已经结束的 ISO 周”减去 `vault/reviews/` 里已存在的 `period`，按最旧到最新补最多 4 周；只有本次生成的最新一期会推送通知话题群，其余只写回 vault。
