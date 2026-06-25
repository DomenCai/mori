---
name: add-mori-schedule
description: 为 mori 新增自定义定时任务。支持纯 script 抓取投递、agent inline prompt 简单提醒、agent task script（脚本返回 prompt/tools/result，框架接入本地 AgentTool 执行）。当用户说"加个定时任务"、"定时提醒"、"定时抓取/拉取某接口"、"每隔 N 小时跑一个脚本"、"做个定时投喂"、"加个 agent 调度"时触发。覆盖写脚本、本地测试、合并 schedules.json、复制到生产 ~/.mori/ 并重启守护进程。
---

# 新增 mori 定时任务

mori 的自定义调度有三种形态：

1. `kind:"script"`：worker 线程运行 `.mjs`，适合纯抓取、纯日报、无需 mori 记忆/工具的任务。
2. `kind:"agent"` + `prompt`：inline prompt，适合简单提醒；可用 `system:"mori"` 和内置工具，但不允许写 Inbox。
3. `kind:"agent"` + `script`：agent task script，适合抓取数据后让 Agent 通过本地工具做结构化选择，再由脚本渲染最终结果。

路径随环境切换：开发态读项目内 `./data/`，生产态读 `~/.mori/`。脚本放 `<ROOT>/script/`，调度配置在 `<ROOT>/schedules.json`。

`kind:"agent"` 任务可以配置 `profile`，值是 `setting.llm.model_profiles` 里的档位名，例如 `normal` / `strong`。创建 agent 调度前必须询问用户是否要指定模型档位；用户不指定就不写 `profile`，运行时回退 `normal`。如果用户指定的档位不存在，运行时也会回退 `normal`。

## 返回值与投递

脚本或 agent task 的最终结果是 `ScheduleResult`：

```js
null
"直接发送给用户的正文"
{
  title: "标题",       // 可选；缺省用 schedule.name
  body: "Markdown 正文", // 必填
  domain: "AI",       // 写 Inbox 时必填
  brief: "一句话摘要", // 写 Inbox 时必填
  tags: ["AI"],       // 可选
  source_url: "https://example.com"
}
```

- `null` / `undefined`：本窗口无投递。
- 无 `deliver.inbox`：只需要 `body`，可只推飞书。
- 有 `deliver.inbox`：必须返回完整文章字段 `title/domain/brief/body`。
- `deliver.notify:true`：推送飞书通知群。
- 既无 `inbox` 又不 notify：允许静默运行，适合维护类任务。

## 形态一：script

仓库内参考：`data/script/aihot-selected.mjs` 是纯 script 抓取 + state 去重 + 返回完整文章的例子。新增类似“定时抓外部源并投递”的任务时，先读这个文件对齐 state 文件、时间窗口、接口字段和返回结构。

```json
{
  "id": "ai-daily",
  "name": "AI 日报",
  "kind": "script",
  "script": "ai-daily.mjs",
  "cron": "0 9 * * *",
  "deliver": { "notify": true },
  "enabled": true
}
```

脚本：

```js
export default async function () {
  const data = await fetch("https://example.com/api").then((r) => r.json());
  if (data.items.length === 0) return null;
  return {
    title: "AI 日报",
    body: data.items.map((item) => `- ${item.title}`).join("\n"),
  };
}
```

## 形态二：agent inline prompt

```json
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
```

约束：

- inline prompt 不允许配置 `deliver.inbox`。
- `system` 默认 `"bare"`；`"mori"` 会注入 mori 的用户信息/记忆 system prompt；也可以填自定义 system prompt 字符串。
- `tools` 只能写内置工具名；不传即不开工具。

## 形态三：agent task script

仓库内参考：`data/script/aihot-daily-selected-agent.mjs` 是 agent task script 例子。它先抓候选内容，再让 Agent 通过自定义工具提交结构化选择，最后由脚本根据工具闭包状态渲染正文。写同类“让 Agent 选择/排序/分类”的任务时优先参考它。

```json
{
  "id": "aihot-selected",
  "name": "AI 精选动态",
  "kind": "agent",
  "script": "aihot-selected-agent.mjs",
  "profile": "strong",
  "cron": "0 */4 * * *",
  "deliver": { "notify": true, "inbox": "AI精选" },
  "enabled": true
}
```

脚本 default export 一个函数，返回 task spec：

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
            terminate: true,
          };
        },
      },
    ],
    result: async () => {
      const selected = items.filter((item) => selectedIds.includes(item.id));
      return {
        title: "AI 精选日报",
        domain: "AI",
        brief: `精选 ${selected.length} 条 AI 动态`,
        tags: ["AI", "精选"],
        body: renderSelected(selected),
      };
    },
  };
}
```

`tools` 可混用内置工具名和自定义 `AgentTool` 对象。自定义工具名不能与内置工具重名。没有 `result` 时，框架默认用 Agent 最终文本作为 `{ body }`。

如果自定义工具用于提交最终结构化结果（如选择 item IDs），工具 `execute` 应把结果写入脚本闭包变量，并返回 `terminate: true`；`result` 再根据闭包变量渲染正文。不要把 Agent 的过程文本或最终解释拼进投递正文，除非用户明确需要这段文字。

## 操作流程

下文 `$SKILL` = 本 skill 所在目录绝对路径。

### 1. 写脚本并合并开发配置

- 脚本写到 `./data/script/`。
- 写新脚本前先读 `data/script/` 下最接近的参考脚本：纯抓取任务看 `aihot-selected.mjs`，Agent 结构化选择任务看 `aihot-daily-selected-agent.mjs`。
- 对接外部接口前先确认真实字段名，不按文档臆测。
- 如果是 `kind:"agent"`，先问用户是否指定模型档位；需要指定时给 helper 传 `--profile <档位名>`。
- 用 helper 幂等合并配置：

```bash
node $SKILL/scripts/merge-schedule.mjs --id <id> --name "<显示名>" \
  --script <name>.mjs --cron "<cron>" --file ./data/schedules.json

node $SKILL/scripts/merge-schedule.mjs --kind agent --id <id> --name "<显示名>" \
  --prompt "<prompt>" --profile normal --system mori --tools search_memory --cron "<cron>" --file ./data/schedules.json

node $SKILL/scripts/merge-schedule.mjs --kind agent --id <id> --name "<显示名>" \
  --script <name>.mjs --profile strong --cron "<cron>" --inbox "<Inbox名>" --file ./data/schedules.json
```

### 2. 本地测试

```bash
node $SKILL/scripts/run-once.mjs <仓库>/data/script/<name>.mjs
```

对普通 script，它打印返回结果；对 agent task script，它打印 `prompt/system/tools/hasResult` 摘要。

如果脚本会写 `.*-state.json`，测试后按用户要求决定是否清理；不要擅自删除用户已有 state。

### 3. 上线前探测生产环境

```bash
bash $SKILL/scripts/detect-env.sh <仓库>
```

- `STATE=A_not_installed`：未安装，转 `deploy-mori`，先问用户。
- `STATE=B_stopped`：已安装未运行，复制配置后先问用户是否启动。
- `STATE=C_running`：运行中，复制配置后重启守护让新增 cron 注册。

### 4. 复制到生产并重启

```bash
mkdir -p ~/.mori/script
cp ./data/script/<name>.mjs ~/.mori/script/
node $SKILL/scripts/merge-schedule.mjs --kind agent --id <id> --name "<显示名>" \
  --script <name>.mjs --profile strong --cron "<cron>" --inbox "<Inbox名>"
$LAUNCH stop && $LAUNCH start
$LAUNCH status
```

只新增或修改 schedule 配置时，需要重启守护进程；只改已有 `.mjs` 内容通常不需要重启。

## 排查

- 没收到卡片：看 `~/.mori/logs/` 当天日志里 `cron` / `script` / `agent` 相关行。
- agent inline 配了 inbox 会报错，这是设计限制。
- agent profile 找不到会回退 `normal`；检查 `setting.json` 的 `llm.model_profiles`。
- 写 Inbox 报缺字段：返回值不是完整文章，补 `title/domain/brief/body`。
- 未知工具：检查 `tools` 中的内置工具名，或自定义工具 `name` 是否拼错。
