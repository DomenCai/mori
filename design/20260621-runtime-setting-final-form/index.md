# Runtime Setting Final Form

> 日期：2026-06-21。状态：目标形态设计，待实现与审查。本文定义配置系统最终边界，后续可以直接交给 Claude 做实现前审查。

## 背景

当前项目还在开发阶段，没有对外发布，所以这次配置重构不做迁移、不做兼容 reader、不保留旧字段兜底。实现时应直接切到本文定义的最终结构；本机已有私有配置由开发者手动搬需要的值。

这次重构要解决三类问题：

- 很多运行参数散落在代码里，例如 script 超时、worker 内存、HTTP 抓取超时、知识地图检查周期。
- 会话生命周期虽然已有 `sessionPolicy`，但放在飞书配置里；新的 `lark_config.json` 应该只放飞书相关状态。
- LLM provider 当前单独放在 `llm-providers.json`，后续应放进统一的 `setting.json`。

## Hermes 参考结论

本机 Hermes 使用 `~/.hermes/config.yaml`，按子系统分组：

- `model`：provider、默认模型、base URL。
- `terminal`：backend、cwd、单次 timeout、终端 lifetime。
- `display`：compact、tool progress 展示级别。
- `compression`：压缩是否启用。
- `api_server`：本地 API server 开关与 host。
- `mcp_servers`：外部工具服务器配置。

值得借鉴的是分组方式和命名边界：模型、执行超时、展示、压缩应分开。不要照搬的是 Hermes 的单默认模型、全局 terminal cwd、`YOLO` 执行模式、空的 MCP 配置壳。PersonalAgent 是 Feishu-first 服务，模型需要按业务 route 分流，脚本 cwd 应属于具体 schedule/script，而不是全局 terminal。

## 配置文件边界

最终保留三个 JSON 配置面：


| 文件                 | 写入方                      | 内容                                                                 | 规则                                      |
| ------------------ | ------------------------ | ------------------------------------------------------------------ | --------------------------------------- |
| `setting.json`     | 人手编辑；首次缺失由 example seed  | LLM provider、时区、会话策略、HTTP、脚本默认限制、knowledge index 周期                | 运行时只读，不被命令或向导自动覆盖                       |
| `lark_config.json` | 飞书注册向导与运行时               | `appId`、`appSecret`、`domain`、`tenant`、`ownerOpenId`、`chatBindings` | 只放飞书相关凭据和绑定状态                           |
| `schedules.json`   | 人手编辑 + `/schedules` 卡片动作 | builtin/script 定时任务定义、启停、cron、script 投递规则                          | 独立于 `setting.json`；不存 `last_run` 这类运行历史 |


其他文件边界：

- `.env` 只放 secret value。`setting.json` 只引用 `apiKeyEnv`，不直接保存 LLM key。
- `agent/` 继续放人可编辑 prompt 与策略文本。
- `app.db`、`sessions/`、`logs/`、`vault/` 是运行数据，不是配置系统。

开发模式路径仍是 `data/`，生产模式路径仍是 `~/.personal-agent/`。仓库只提交 `data/setting.example.json`；真实 `data/setting.json`、`data/lark_config.json`、`data/schedules.json` 都按私有运行配置处理。

## setting.json 结构

`setting.json` 使用 JSON，不切 YAML。原因是当前项目的运行配置事实是 JSON；`yaml` 依赖只服务于知识库 Markdown frontmatter。Hermes 的价值在分组，不在文件格式。

示例：

```json
{
  "llm": {
    "providers": {
      "main": {
        "api": "openai-responses",
        "baseUrl": "https://api.example.com/v1",
        "apiKeyEnv": "PERSONAL_AGENT_API_KEY",
        "headers": {},
        "request": {
          "cacheRetention": "long"
        },
        "models": {
          "gpt-5.5": {
            "name": "GPT 5.5",
            "input": ["text"],
            "reasoning": true,
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          "gpt-5.5-fast": {
            "name": "GPT 5.5 Fast",
            "input": ["text"],
            "reasoning": true,
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        }
      }
    },
    "model_profiles": {
      "normal": {
        "provider": "main",
        "model": "gpt-5.5"
      },
      "strong": {
        "provider": "main",
        "model": "gpt-5.5"
      }
    },
    "routes": {
      "companion": "normal",
      "weekly": {
        "profile": "strong",
        "thinkingLevel": "medium"
      }
    }
  },
  "time": {
    "timezone": "Asia/Shanghai"
  },
  "sessions": {
    "sweepIntervalMs": 300000,
    "policies": {
      "diary": {
        "autoClose": true,
        "idleMinutes": 60
      },
      "dm": {
        "autoClose": true,
        "idleMinutes": 120
      },
      "thread": {
        "autoClose": true,
        "idleMinutes": 30
      },
      "topic": {
        "autoClose": false
      }
    }
  },
  "script": {
    "defaults": {
      "timeoutMs": 60000,
      "resourceLimits": {
        "maxOldGenerationSizeMb": 128,
        "maxYoungGenerationSizeMb": 32
      }
    }
  },
  "http": {
    "fetch": {
      "timeoutMs": 30000,
      "userAgent": "PersonalAgent/1.0"
    }
  },
  "knowledge": {
    "index": {
      "checkIntervalMs": 3600000
    }
  }
}
```

### LLM

`setting.llm` 直接承载当前 `llm-providers.json` 的三段式结构：`providers`、`model_profiles`、`routes`。这比 Hermes 的单 `model.default` 更适合 PersonalAgent，因为当前至少有 `companion` 和 `weekly` 两条业务 route。

三段职责：

- `providers` 描述一个 endpoint 怎么连，以及这个 endpoint 下有哪些模型。provider key（例如 `main`）是 PersonalAgent 内部连接名，也作为合成 `Model.provider` 时的展示和诊断标签。`api` 直接使用 `@earendil-works/pi-ai` 的 API surface，例如 `anthropic-messages`、`openai-responses`、`openai-completions`；不再保留 `type -> api` 映射，也不额外配置上游 provider 名。
- `providers.<name>.request` 对应 `AgentHarnessStreamOptions`。当前先只放确认会生效的字段：`cacheRetention`（不再写死为 `long`）。`timeoutMs`、`maxRetries`、`maxRetryDelayMs` 等只有在实现时确认 pi-agent-core 真正消费后再加入；不放暂时不会生效的字段。
- `providers.<name>.models` 是模型事实表。每个 model 配置 `name`、`input`、`reasoning`、`contextWindow`、`maxTokens`。`cost` 为可选字段：`pi-ai` 的 `Model` 类型要求 `cost`，当前没有费用展示，缺省按全 0 合成即可；以后要在卡片/日志展示成本时再按 `pi-ai` 字段名（`input`、`output`、`cacheRead`、`cacheWrite`）逐 model 填。`thinkingLevelMap`、`compat` 本轮不暴露：`compat` 在以后对接 OpenAI-compatible proxy（LiteLLM/Ollama/vLLM）出问题时，再作为 advanced model field 加入，不进第一版主配置。
- `model_profiles` 只是模型别名，用来表达普通模型、强模型等业务命名。profile 只允许配置 `provider` 和 `model`，不能重复配置 `contextWindow`、`maxTokens`、`cost` 等模型事实。
- `routes` 描述具体 agent route 使用哪个模型。route 值只允许两种形态：profile key 字符串（如 `"normal"`），或 `{ "profile": "strong", "thinkingLevel": "medium" }`。不提供 inline `{ provider, model }` 形态——`model_profiles` 已是别名层，inline 会制造第二套选择入口。route 级只放运行时选择（如 `thinkingLevel`）；模型事实仍回到 `providers.<name>.models` 读取。

实现要求：

- `resolveModelRoute(routeName)` 只从 `setting.llm` 解析。
- `apiKeyEnv` 继续从 `.env` 取值。
- `resolveModelRoute(routeName)` 返回 `model`、`apiKey`、`streamOptions`、`thinkingLevel`。其中 `model` 由 provider 的连接字段和 model facts 合成，`streamOptions` 来自 `provider.request`。
- `thinkingLevel` 表示当前 route 是否启用 reasoning 以及启用到什么档位；`reasoning` 只表示模型能力，不能混成运行时开关。
- runtime 只校验当前 route 会用到的 provider、model、profile，不因为未使用的 provider/model/profile 残缺而启动失败。

### 时间与时区

`setting.time.timezone` 是全局业务时区配置，默认 `Asia/Shanghai`。

它统一影响：

- cron scheduler 的 timezone。
- daily memory 选择“前一个自然日”的边界。
- `date_key`、`week_key`、run window 等日期键。
- 日志按天切分、session 文件名、知识地图更新时间等面向人的本地日期展示。
- nudge 的沉默天数计算。

实现要求：

- 必须使用 IANA timezone 名称，例如 `Asia/Shanghai`、`America/Los_Angeles`。
- 启动时校验 timezone；无效值应 fail fast，不静默回退。
- 默认值只在 `setting.example.json` 和缺失 seed 中体现；业务代码不再直接写死 `Asia/Shanghai`。
- 现有 `shanghai*` 命名的 util 可以在实现时重命名或包一层兼容的内部函数，但语义必须来自 `setting.time.timezone`。

### 会话与新会话触发

`setting.sessions.policies` 是新会话重新触发时间的唯一配置入口。

语义：

- `HarnessManager.getOrCreate(scopeId, chatType)` 查到内存 entry 就续聊。
- scope 因 idle cleanup、`/new` 或进程重启消失后，同一个 scope 的下一条消息才会创建新 session。
- `dm.idleMinutes = 120` 表示私聊空闲两小时后可被 cleanup 删除；因为 `sweepIntervalMs = 300000`，实际删除会最多晚 5 分钟。
- `topic.autoClose = false` 表示主题群默认不靠 idle 自动关闭，只通过 `/new`、手动 compact 或进程重启收束。

`lark_config.json.sessionPolicy` 不应存在；会话策略不属于飞书配置。

### 自动压缩（拆为后续单独 PR）

自动 85% 压缩是**新功能，不属于本轮配置重构**。当前源码只有手动 `/compact` 和 `compactSession()`（`src/agent/harness.ts:156`），没有自动触发。本轮 `setting.json` 不放 `compaction` 段，`sessions.policies.<type>` 也不放 `compaction` 子项；等自动压缩单独设计/实现时再引入对应配置。

设计要点先记在这里，供后续 PR 参考：

- 指标入口已就绪：`src/lark/messageHandlers.ts` 已监听 `turn_end` 并读到 `usage.totalTokens` 与 `harness.getModel().contextWindow`，不需要额外接线。
- 真正的难点在触发时机：必须在用户可见回复完成、assistant message 已持久化、harness 回到 idle 之后再 compact，不能在流式事件回调里直接调用（`AgentHarness.compact()` 要求 idle）。
- 失败处理：压缩失败只记 warn，不改变已经发给用户的回复。
- 阈值与 `customInstructions` 是 app 级策略；`reserveTokens` / `keepRecentTokens` 当前不被 `AgentHarness.compact()` 公开 API 接收，届时不要放进配置。

### script 与 schedules

script 默认运行限制放在 `setting.script.defaults`。单个 script schedule 的执行覆盖仍属于 `schedules.json`，例如：

```json
{
  "schedules": [
    {
      "id": "daily-paper-digest",
      "kind": "script",
      "enabled": true,
      "cron": "0 8 * * *",
      "script": "daily-paper-digest.mjs",
      "runtime": {
        "timeoutMs": 180000,
        "resourceLimits": {
          "maxOldGenerationSizeMb": 256,
          "maxYoungGenerationSizeMb": 64
        }
      },
      "deliver": {
        "inbox": "papers",
        "notify": true
      }
    }
  ]
}
```

这样可以保留 `schedules.json` 的独立性，同时不把 script 默认 timeout 继续写死在 `cron.ts`。

### HTTP 与知识库

`setting.http.fetch` 控制 `fetchArticle()` 的 `timeoutMs` 和 `userAgent`。抓取必须使用 `AbortController`；不能继续无限等待。

`setting.knowledge.index.checkIntervalMs` 控制 knowledge index 的后台评估周期，替代当前 1 小时硬编码。

其余 prompt 质量调参不进配置：知识地图 prompt 预算（`targetTokens`）、`grep` 结果上限、`memory.*`（snapshot/daily/weekly/storylines 的各项 limit 与天数阈值）都属于内部叙事策略与上下文配额，只有开发者会调、改动会影响产品行为，留作代码常量更符合 KISS，见下文「保留为代码规则的内容」。

## lark_config.json 结构

`lark_config.json` 只保留飞书相关字段：

```json
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "domain": "https://open.feishu.cn",
  "tenant": "feishu",
  "ownerOpenId": "ou_xxx",
  "chatBindings": [
    {
      "chatId": "oc_xxx",
      "chatType": "diary",
      "name": "日记群",
      "createdAt": "2026-06-21T00:00:00.000Z"
    }
  ]
}
```

不允许放：

- LLM provider / model route。
- session policy。
- script timeout。
- schedule definition。
- prompt budget。

`saveLarkConfig()` 只写这个文件；任何运行时自动写入都不能改 `setting.json`。

## 保留为代码规则的内容

不是所有常量都要配置化。以下仍留在代码里：


| 内容                                                          | 理由                                |
| ----------------------------------------------------------- | --------------------------------- |
| script 只允许 `.mjs`、路径不能越界                                    | 安全边界                              |
| vault 路径边界、文件权限 `0600/0700`                                 | 安全边界                              |
| chatType 可用工具集合、schema enum                                 | 权限与业务规则，不是运行参数                    |
| Feishu `dmMode: "open"`、`requireMention: false`             | 当前个人 Agent 产品行为                   |
| 卡片内部截断长度、`display` 工具过程展示                                   | Feishu 展示稳定性与产品偏好，本轮无痛点           |
| `memory.*`（snapshot/daily/weekly/storylines 各项 limit 与天数阈值） | 内部叙事策略与 prompt 配额，只有开发者调，改动影响产品行为 |
| 知识地图 `targetTokens`、`grep` 结果上限                             | prompt 上下文成本调参，同上                 |
| SQLite schema、FTS/LIKE 检索分流                                 | 数据结构与实现策略                         |


如果以后要全量检查 `setting.json`，应做显式 lint/inspect 命令；业务启动路径只校验当前会用到的字段。

## 实现拆分

1. 在 `src/config.ts` 新增 `SettingConfig`、`settingPath`、`loadSetting()`，生产首次从 `data/setting.example.json` seed 到 ROOT。
2. `loadLlmConfig()` 改为读取 `loadSetting().llm`，删除运行时 `llm-providers.json` 读取路径，并删除 `type -> api` 映射。
3. `LarkConfig` 删除 `sessionPolicy`；`loadLarkConfig()` / `saveLarkConfig()` 只处理飞书字段。
4. `main.ts` 从 `setting.sessions` 读取 idle cleanup policy 和 `sweepIntervalMs`。
5. 时间工具、cron、日志/session 文件命名、daily memory、weekly key、nudge 天数统一从 `setting.time.timezone` 读取，默认 `Asia/Shanghai`。
6. `resolveModelRoute()` 按 route 解析 profile（字符串或 `{ profile, thinkingLevel }`），合成 `Model`（per-model `contextWindow/maxTokens`，`cost` 缺省全 0）、`AgentHarnessStreamOptions`（当前仅 `cacheRetention`）和 `thinkingLevel`。
7. `HarnessManager` 接收 setting 中的 LLM route 解析结果。
8. `schedule/cron.ts` 从 `setting.script.defaults` 和 schedule item 的 `runtime` 覆盖合并 script timeout/resource limits。
9. `knowledge/vault.ts` 的 fetch 使用 `setting.http.fetch`（带 `AbortController`）；knowledge index 后台周期改读 `setting.knowledge.index.checkIntervalMs`。
10. 更新 `docs/configuration.md`、`docs/sessions.md`、`docs/schedules.md` 和 example 文件。

自动压缩不在本轮范围（见「自动压缩（拆为后续单独 PR）」）。

实现时不需要迁移旧配置：

- 不读取旧 `llm-providers.json`。
- 不从旧飞书配置里的 `sessionPolicy` 搬值。
- 不给旧字段保兼容分支。
- 真实本地值由开发者手动搬到 `setting.json`。

## Claude 审查重点

后续让 Claude 审查时，重点看这些问题：

- `lark_config.json` 是否真的只剩飞书相关字段。
- `setting.json` 是否承载了 LLM provider、timezone、idle policy、script timeout/resource limits、HTTP timeout、knowledge index 周期。
- `schedules.json` 是否仍独立，script 单项覆盖是否没有塞进 `setting.json`。
- 时区是否真的从 `setting.time.timezone` 读取，默认上海，无效值 fail fast。
- routes 是否只有 profile 字符串与 `{ profile, thinkingLevel }` 两种形态，没有 inline `{ provider, model }`。
- `setting.json` 是否没有混入 `memory.*`、`targetTokens`、`grep.maxResults`、`display`、`compaction` 这些应留代码常量或属于后续 PR 的字段。
- runtime 是否没有写回 `setting.json`。
- 是否没有引入兼容 reader、迁移层或旧字段兜底。
- 是否没有把安全边界和工具权限误做成用户配置。

