# 配置参考

这份文档集中说明 mori 的运行配置：文件在哪、各管什么、怎么改。安装与守护运行见 [CLI 使用指南](cli.md)，本地开发见 [开发指南](development.md)，功能总览见 [文档总览](index.md)。

## 数据根（ROOT）

所有配置和运行状态都挂在一个 ROOT 目录下，由环境变量 `MORI_DEV` 决定位置：

| 模式 | 触发 | ROOT |
|---|---|---|
| 生产 | 正常运行 CLI | `~/.mori` |
| 开发 | `pnpm dev`（已设 `MORI_DEV=1`） | 项目内 `./data` |

生产模式下，用户可改的 `.env`、`setting.json` 和 `agent/` 首次缺失时会从仓库模板 seed 到 ROOT，之后改 ROOT 里的副本。开发模式直接读写仓库原位文件；真实 `data/setting.json`、`data/lark_config.json`、`data/schedules.json` 都是私有运行配置，不提交。

## 配置文件一览

| 文件 | 谁写入 | 内容 | 规则 |
|---|---|---|---|
| `setting.json` | 人手编辑；首次缺失由 `data/setting.example.json` seed | LLM provider、模型路由、时区、会话策略、HTTP 抓取、script 默认限制、knowledge index 周期 | 运行时只读 |
| `lark_config.json` | 首次扫码向导 + 运行时自动更新 | 飞书凭据、owner、chat 绑定 | 只放飞书相关状态 |
| `schedules.json` | 人手编辑 + `/schedules` 卡片动作 | 定时任务启停、cron 覆盖、script 任务定义 | 不存运行历史 |
| `.env` | 模板 seed 后人手编辑 | LLM API key | 只放 secret value |
| `agent/*.md` | 模板 seed 后人手编辑 | 提示词与策略文本 | 重启后生效 |

## 飞书凭据 `lark_config.json`

首次前台运行 `mori run`（或 `pnpm dev`）会渲染二维码，飞书扫码后自动创建 / 授权应用，凭据写入 `lark_config.json`。

字段（见 `LarkConfig`）：

| 字段 | 含义 |
|---|---|
| `appId` / `appSecret` | 应用凭据 |
| `domain` / `tenant` | `feishu` 或 `lark`（国际版） |
| `ownerOpenId` | 主人 open_id；扫码时飞书没返回的话，由第一条私聊消息绑定 |
| `chatBindings` | 日记群、主题群、私聊等 chat 的类型绑定 |

`lark_config.json` 不保存 LLM、session policy、script timeout 或 schedule definition。会话策略在 `setting.json`。

## LLM 与模型路由 `setting.json`

`.env` 只填 key 值；`setting.json` 通过 `apiKeyEnv` 引用环境变量名：

```env
ANTHROPIC_API_KEY=sk-ant-...
```

`setting.llm` 分三段：

```json
{
  "llm": {
    "providers": {
      "main": {
        "api": "anthropic-messages",
        "baseUrl": "https://api.anthropic.com",
        "apiKeyEnv": "ANTHROPIC_API_KEY",
        "headers": {},
        "request": {
          "cacheRetention": "long"
        },
        "models": {
          "claude-sonnet-4-20250514": {
            "name": "Claude Sonnet 4",
            "input": ["text"],
            "reasoning": false,
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        }
      }
    },
    "model_profiles": {
      "normal": { "provider": "main", "model": "claude-sonnet-4-20250514" },
      "strong": { "provider": "main", "model": "claude-sonnet-4-20250514" }
    },
    "routes": {
      "companion": "normal",
      "weekly": { "profile": "strong", "thinkingLevel": "medium" }
    }
  }
}
```

- `providers` 描述 endpoint 怎么连，以及 endpoint 下有哪些模型。`api` 直接使用 pi-ai API surface，例如 `anthropic-messages`、`openai-responses`、`openai-completions`。
- `providers.<name>.request.cacheRetention` 会作为 harness stream option 生效。
- `models` 是模型事实表：`name`、`input`、`reasoning`、`contextWindow`、`maxTokens`，`cost` 可选，缺省按 0 合成。
- `model_profiles` 只允许配置 `provider` 和 `model`。
- `routes` 只允许 profile 字符串，或 `{ "profile": "...", "thinkingLevel": "..." }`。

运行时只校验当前 route 会用到的 provider、profile、model 和 key，不做全量 lint。

## 时间、会话与运行默认值

`setting.time.timezone` 是全局业务时区，必须是 IANA timezone，例如 `Asia/Shanghai` 或 `America/Los_Angeles`。缺失或无效都会启动失败，不会静默回退系统时区。它影响 cron、daily memory 自然日、日志文件日期、session 文件名、日期 key 和周 key。

`setting.sessions` 控制空闲会话清理：

```json
{
  "sessions": {
    "sweepIntervalMs": 300000,
    "policies": {
      "diary": { "autoClose": true, "idleMinutes": 60 },
      "dm": { "autoClose": true, "idleMinutes": 120 },
      "thread": { "autoClose": true, "idleMinutes": 30 },
      "topic": { "autoClose": false }
    }
  }
}
```

`setting.script.defaults` 是 script schedule 的默认 timeout 和 worker `resourceLimits`。单个 script 可在 `schedules.json` 的 `runtime` 里覆盖。

`setting.http.fetch` 控制 `fetch_article` 的 `timeoutMs` 和 `userAgent`。`setting.knowledge.index.checkIntervalMs` 控制 knowledge index 后台评估周期。

## Web Search

`web_search` 是 companion harness 的通用只读工具，给普通聊天和认知透镜（lens）查外部事实用。配置放在 `setting.knowledge.search`：

```json
{
  "knowledge": {
    "search": {
      "provider": "tavily",
      "apiKeyEnv": "TAVILY_API_KEY"
    }
  }
}
```

`provider` 只能是 `tavily` 或 `brave`。`.env` 里填对应 key：

```env
TAVILY_API_KEY=tvly-...
BRAVE_API_KEY=...
```

只有 `setting.knowledge.search` 和对应环境变量同时存在时，运行时才会注册并暴露 `web_search`。缺配置或缺 key 时普通聊天不会看到搜索工具，`/plain` 也只保留 `fetch_article`，不会因为缺搜索 key 让回复失败。

Tavily 搜索结果可能带清洗正文，`web_search` 会保留到 `content` 字段；Brave 只返回标题、URL 和摘要。对象本身是 URL 时仍走 `fetch_article`，不用搜索工具重复抓取。

已有部署如果已经有自己的 `setting.json`，可以手动补上 `knowledge.search` 和对应 key；新装环境会从 `data/setting.example.json` seed 出这一段。

## 定时任务 `schedules.json`

内置任务基线写在代码里，`schedules.json` 是覆盖层：只需要写 `id` 和要覆盖的字段；代码不认识的 builtin 会被忽略，script 任务以 JSON 为唯一来源。

默认 builtin：

| id | builtin | 默认触发 |
|---|---|---|
| `weekly-summary` | `weekly_summary` | `55 23 * * 0` |
| `daily-memory` | `daily_memory` | `0 6 * * *` |
| `knowledge-index` | `knowledge_index` | 新增内容量阈值 |

`/schedules` 会读取合并后的配置，并把启停状态写回 `schedules.json` 的覆盖层。任务行为、script 契约和投递流程见 [定时任务](schedules.md)。

## 保留为代码规则的内容

安全边界和内部产品策略不放进 `setting.json`：script 只允许 `.mjs`、路径不能越界；vault 路径和文件权限；chatType 可用工具集合；Feishu 卡片展示截断；`memory.*`；知识地图 prompt 预算；`grep` 结果上限；SQLite schema 与检索策略。
