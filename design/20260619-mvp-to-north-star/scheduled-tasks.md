# 定时任务框架（Scheduled Tasks）

> Post-MVP 北极星设计。框架只提供"定时调度 + 投递"的基建,**本身不实现任何具体知识任务**——具体任务由用户写成脚本。
> 依赖:`storage-architecture.md`(vault 写、`messages`、config)、`knowledge-base.md`(Inbox 投递格式)。

---

## 1. 总原则:三刀切

| 谁 | 管什么 | 在哪 |
|---|---|---|
| **`schedules.json`(配置)** | **何时执行 + 怎么处理产出** | 配置层 JSON |
| **用户脚本(逻辑)** | **产出什么**:纯逻辑,**不碰飞书** | `scriptDir/*.mjs` |
| **框架(基建)** | **怎么投递**:写 Inbox、发通知群、记 `messages` | 框架代码 |

脚本永远只 `return` 内容,框架全权决定怎么处理产出。

---

## 2. 任务两种 kind

### 2.1 `builtin` —— 框架自带,自有规则

不是"用户任务",是框架功能,耦合内部服务、投递目标各异,**框架内部 handler 实现**,不走用户脚本契约。三个:

| builtin | 触发 | 投递 | 走 LLM |
|---|---|---|---|
| `weekly_summary` | 周日 23:55 | 日记群 + 存 `weekly_summaries` | 是(sub-agent) |
| `diary_reminder` | 每天检查 | 日记群 | 否(纯代码查 `messages` 最后时间) |
| `knowledge_index` | 内容量阈值(N=5 或 T=3 天) | 写快照槽位文件 | 是(sub-agent) |

> `knowledge_index` 详见 `knowledge-base.md` §7;`weekly_summary` 的隔离 sub-agent 形态见 §5。

### 2.2 `script` —— 用户脚本,只发通知群

用户自己写的知识投喂任务(AI 日报、知识卡片等)。**产出只发通知群 + 写 Inbox**(因为快照投递已由 builtin `knowledge_index` 承担,script 无需放宽到文件投递)。

---

## 3. 脚本契约

脚本放在 `scriptDir = join(ROOT, "script")`(`config.ts` 新增导出),纯 **`.mjs` ESM**(零构建,运行时 `import()` 加载;不引入 TS 运行时加载器)。

```js
// scriptDir/ai-daily.mjs
export default async function run() {
  // 纯逻辑：拉 RSS / 调 API / 整理……自己做网络请求
  return {
    title: "今日 AI 要闻",
    domain: "AI",
    tags: ["news"],
    brief: "三条值得看的",
    body: "# ...\n（markdown 正文）",
    source_url: "https://...", // 可选
  };
}
```

- 脚本**只返回结构化字段**,**框架据此渲染 frontmatter + 正文**写成 `.md`——保证每个 vault 文件都有 frontmatter 且格式永远正确(脚本无法写歪 YAML)。
- frontmatter 用 **YAML serializer 渲染(`yaml`/`js-yaml`,绝不字符串拼接)**:这样标题/brief/tags 里出现冒号、换行、`---`、中文等都会被正确转义,合法性由 serializer 本身保证(不靠写完再 parse 回读这种事后防御)。
- 必填字段(`title`/`domain` 等)由返回值 schema **强制**,缺字段就报错不落库。

---

## 4. `schedules.json`

与 `config.json` 并列的配置文件。**只存定义,零运行时状态**(无 `last_run`):幂等性靠现有领域数据推导(周总结看 `weekly_summaries.week_key UNIQUE`,提醒看 `messages` 最后时间,index 看 index 文件 mtime)。

```jsonc
{
  "schedules": [
    { "id": "...", "name": "周总结", "kind": "builtin", "builtin": "weekly_summary",
      "cron": "55 23 * * 0", "enabled": true },
    { "id": "...", "name": "记日记提醒", "kind": "builtin", "builtin": "diary_reminder",
      "cron": "0 21 * * *", "enabled": true },
    { "id": "...", "name": "知识地图", "kind": "builtin", "builtin": "knowledge_index",
      "trigger": { "type": "volume", "n": 5, "days": 3 }, "enabled": true },

    { "id": "...", "name": "AI 日报", "kind": "script", "script": "ai-daily.mjs",
      "cron": "0 8 * * *", "deliver": { "notify": true, "inbox": "AI日报" }, "enabled": true }
  ]
}
```

- 初始化时若 `schedules.json` 缺失,**框架种入三个 builtin**(用户可手动 `enabled: false` 关掉)。
- `/schedules` 斜杠命令:读 `schedules.json` 渲染成卡片、可开关。
- **script 的幂等**(daemon 重启 / 手动重跑不重复投递):产出文件名走**确定性 slug**(`<schedule.id>-<run-window>`,run-window 取 cron 命中的日期/时段),框架写 Inbox 前先看该路径是否已存在——**已存在则跳过整次投递**(不重写文件、不重发卡)。slug 用 schedule id 而不是脚本名,避免同一个 `.mjs` 被多个 schedule 复用时互相撞文件。这样无需 `schedule_runs` 之类运行时状态表,幂等性仍由文件系统自身承载,贴合"零运行时状态"。

---

## 5. Runner:builtin 进程内 / script 隔离 worker

**两类任务跑在不同地方,因为它们对资源和信任的需求相反:**

- **builtin** 是框架内部函数,本来就需要 daemon 独占的飞书 WS 连接 + db + consolidation 等 service(它的产出要直接发群、写库)。它是可信框架代码,**留在 daemon 进程内直接调用**,全权拿一切资源。
- **script** 是用户写的纯逻辑:只 `return` 结构化数据,**不碰飞书、不碰 db**(投递全由框架在拿到返回值之后做)。它既不需要 daemon 的任何资源,又是最可能写错的一环——所以**放进 `worker_threads` 隔离执行**。

> 注:script **不需要** daemon 的连接(投递是框架的事,不是脚本的事),因此"必须进程内才够得着连接"对 script 不成立;那条理由只适用于 builtin。

**为什么是 worker 而不是 try/catch**:in-process import 挡不住 CPU 死循环、top-level `import()` 卡死、污染全局——这些都会冻住 daemon 的 WS event loop,直接违反"坏脚本不能拖垮 daemon"。`worker_threads` 才真正满足这条边界:

- 脚本在独立线程跑,**wall-clock 超时到点 `worker.terminate()` 强杀**——连 CPU 死循环都能终止。
- worker 创建时设置 `resourceLimits`(至少限制 JS heap)并配合 wall-clock timeout。`worker_threads` 不是安全沙箱,但足够覆盖本地可信脚本的常见错误隔离:CPU 死循环、超时、throw、reject 和过量 JS 内存。
- 脚本未捕获异常 → worker 的 `error` 事件,**不触发主进程 `uncaughtException`**,daemon 不退。
- 返回值是纯 JSON(`{title, domain, tags, brief, body, source_url?}`),天然可结构化克隆传回主线程,零额外序列化负担。
- Node 原生,**无新依赖**;实现就是一个小 worker 入口(`import` 用户 `.mjs` → `run()` → `postMessage` 结果)+ 主线程侧的超时/terminate 包装。
- script 跑挂(throw / 超时 / 退出码非 0)只**记错误 + 发一条失败通知**,不写 Inbox、不影响 WS daemon。

### 投递流程(script kind)

1. croner 命中 → 起 worker 跑脚本 `run()` → 主线程拿到结构化返回(超时则 terminate 并记失败,流程终止)。
2. **幂等**:按确定性 slug(`<schedule.id>-<run-window>`)算目标路径 `Inbox/<deliver.inbox>/YYYY-MM/<slug>.md`,已存在则跳过本次投递(§4)。
3. 框架用 YAML serializer 渲染 `frontmatter + body` → 写该 `.md`(确保月目录存在)。
4. **通知群**:未绑定则先 `channel.createChat` 建一个并写进 `config.chatBindings`;发知识卡片。
5. 记一条 `messages`(role=assistant,`knowledge_path` 指向刚写的 `.md`)——接上反馈回路(见 `knowledge-base.md` §5)。

---

## 6. builtin 隔离 sub-agent 形态

走 LLM 的 builtin(`weekly_summary` / `knowledge_index`)复用现有周总结形态:独立 scope(`<name>_<runId>`)+ 全新 session + 只塞任务输入的聚焦 prompt + 跑完 `resetSession`,**不带任何对话上下文**。

**目标驱动**:每个 sub-agent 的 prompt 必须以明确目标开头,且目标挂北极星,它才会做对取舍:

- 周总结:`维持一份准确、当前的"我是谁/我在做什么"工作模型,并以朋友身份诚实回顾我这一周。更新工作集、保守动画像、写回顾都服务于此,不是产出报告。`
- 知识地图:见 `knowledge-base.md` §7.1。

> 现有**两个** LLM 批处理 builtin 形态一致,但**先不抽象成框架**(单/双实现不抽象),各写各的、守同一约定;出现第三个再提取。

---

## 7. 非目标

- 框架不实现任何"知识任务"的具体逻辑(那是用户脚本的事)。
- `schedules.json` 不存运行时状态。
- `script` 不支持向通知群以外投递(快照投递归 builtin)。
- 不支持 `.ts` 脚本(不引入运行时 TS 加载器);用 `.mjs`。
