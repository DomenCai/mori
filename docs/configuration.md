# 配置参考

这份文档集中说明 Personal Agent 的所有配置：文件在哪、各管什么、怎么改。安装与守护运行见 [CLI 使用指南](cli.md)，本地开发见 [开发指南](development.md)。

## 数据根（ROOT）

所有配置和运行状态都挂在一个 ROOT 目录下，由环境变量 `PERSONAL_AGENT_DEV` 决定位置：

| 模式 | 触发 | ROOT |
|---|---|---|
| 生产 | 正常运行 CLI | `~/.personal-agent` |
| 开发 | `pnpm dev`（已设 `PERSONAL_AGENT_DEV=1`） | 项目内 `./data` |

**生产**模式下，用户可改的文件（`.env` / `llm-providers.json` / `agent/`）首次缺失时会从仓库内置模板自动 seed 一份到 ROOT，之后改 ROOT 里的副本。**开发**模式直接读写仓库原位文件，改完即时生效，不污染 `~/.personal-agent`。

下文路径以生产模式 `~/.personal-agent/` 为例；开发模式对应到 `./data/`（提示词在仓库根的 `agent/`）。

## 配置文件一览

| 文件 | 谁生成 | 内容 | 要不要手改 |
|---|---|---|---|
| `config.json` | 首次扫码向导 + 运行时自动更新 | 飞书凭据、owner、chat 绑定 | 通常不用手填 |
| `.env` | 模板 seed | LLM API key | **要填** |
| `llm-providers.json` | 模板 seed | provider / 模型 / 路由 | 按需 |
| `agent/*.md` | 模板 seed | 提示词 | 按需 |

## 飞书凭据 `config.json`

首次前台运行 `personal-agent run`（或 `pnpm dev`）会渲染二维码，飞书扫码后自动创建 / 授权应用，凭据写入此文件，**无需手填 appId / secret**。

字段（见 `LarkConfig`）：

| 字段 | 含义 |
|---|---|
| `appId` / `appSecret` | 应用凭据 |
| `domain` / `tenant` | `feishu` 或 `lark`（国际版） |
| `ownerOpenId` | 主人 open_id；扫码时飞书没返回的话，由第一条私聊消息绑定 |
| `chatBindings` | 日记群、主题群、私聊等 chat 的类型绑定 |

`chatBindings` 放在 `config.json` 而不是 `app.db`，这样重建数据库不会丢已创建群的路由关系。文件权限自动设为 `0600`，**不要提交到 git**。

## LLM key `.env`

填 `llm-providers.json` 里 `apiKeyEnv` 指向的环境变量。默认配置用 Anthropic：

```
ANTHROPIC_API_KEY=sk-ant-...
```

换 provider 就填对应的 key 名。`.env` 在任何环境变量读取之前加载。

可选：`LOG_LEVEL=debug`（`debug` | `info` 默认 | `warn` | `error`）临时调日志级别。

## 模型路由 `llm-providers.json`

换模型、换供应商只动这个 JSON，不碰代码。三段结构：

```json
{
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 8192
    }
  },
  "model_profiles": {
    "companion": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    "strong":    { "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
  },
  "routes": {
    "companion": "companion",
    "weekly": "strong"
  }
}
```

- **providers** —— 一个供应商怎么连。`type` 取 `anthropic` / `openai_response` / `openai_completions` / `xai_responses`；`apiKeyEnv` 指向 `.env` 里的 key 名；`baseUrl`、`reasoning`、`contextWindow`(默认 200000)、`maxTokens`(默认 8192)、`headers`、`input` 可选。
- **model_profiles** —— 给"某个 provider 的某个具体模型"起个名字。
- **routes** —— 把业务路由映射到 profile。两条固定路由：

  | 路由 | 用途 |
  |---|---|
  | `companion` | 日常对话、记日记 |
  | `weekly` | 周度合并（更强模型） |

举例：要让日常对话换成另一个模型，改 `model_profiles.companion.model` 即可；要让两条路由用不同供应商，各自指向不同 profile。

## 提示词 `agent/`

`soul.md` / `response_style.md` / `memory_policy.md` 等纯 Markdown，定义 Agent 的人格、回复风格、记忆策略。直接编辑，开发态即时生效，生产态重启进程后生效。

## 硬编码参数（非配置）

少数运行参数目前写死在代码里，改它们需要改源码并重新 build：

| 参数 | 值 | 位置 |
|---|---|---|
| 会话空闲冷却时长 | 60 分钟 | `src/main.ts` |
| 冷却扫描周期 | 5 分钟 | `src/main.ts` |

会话冷却规则详见 [会话与冷却规则](sessions.md)。

## 升级时配置怎么办

`~/.personal-agent/` 下的配置和数据**不随升级覆盖**。重装新版本后这些文件原样保留；只有首次缺失时才会从模板 seed。
