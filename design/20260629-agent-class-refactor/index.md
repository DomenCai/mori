# Agent 类化重构

## 状态

2026-06-29 已按当前代码落地，待 `pnpm build` 和主路径手动验证。

实际实现与设计草稿有两点命名差异：

- 原文里的 `HarnessManager` 现在对外表现为 `AgentService`，会话选择、per-scope lock、idle cleanup、reply-target reopen、一次性 agent runner 都在 `src/agent/service.ts`。
- 原文里的 `harness.ts` 被物理拆掉，harness 装配在 `src/agent/harnessFactory.ts`，运行时薄壳在 `src/agent/runtime.ts`，工具全集和默认工具解析在 `src/agent/toolCatalog.ts`。

## 背景

`src/agent/harness.ts` 目前约 1000 行，把三件事混在一个文件里：

1. **Session lifecycle**：per-scope lock、SessionRegistry 的 reopen/unclosed/reply-target 三种恢复算法、segment window、message 记录、idle cleanup、JsonlSessionRepo 文件名 hook、profile 解析。
2. **Agent 策略**：prompt tail（`appendSessionInstructions`）、默认工具集（`activeToolNamesFor`）、能否编辑画像（`createEntry` 里的 `canEditProfile`）。
3. **一次性任务编排**：`runEpisodeDistill` / `runKnowledgeIndexBuiltin` / `runTask` 三段独立长方法，模式相同（临时 scope → prompt → subscribe 抽结果 → resetSession），但抽结果方式各异——流式拼 `text_delta` / 等 `turn_end` 抓最终文本 / 只看副作用——三处 subscribe 逻辑都是手写的。

加上散在 manager 外的 `runEpisodeDistill` 入口之外，`src/memory/daily-memory.ts` 和 `src/memory/consolidation.ts` 也各自有 `getOrCreate → subscribe → prompt → resetSession` 的副本（dream/nudge 两轮、主轮/friend 轮），subscribe 模板重复扩散到了 memory 层。

dm/topic/thread/diary 这四种本质上是同一个 ChatAgent，只在 prompt tail 和默认工具集上有差异；后台 agent（distill / knowledge_index / daily_memory / consolidation / schedule）彼此之间也很像，都是一次性会话。

## 目标

把 **agent 策略** 抽象成类，每种 agent 一个文件，新增一种 agent = 新增一个文件 + 在路由表里登记一行。

HarnessManager 保留 **session lifecycle** 职责（entry 池、lock、恢复算法、idle cleanup），但 lifecycle 相关的 chatType 分支用一张表集中化，避免散落成多个函数。

`runFor*` helper 抽到 BaseAgent 后，memory 层 daily/consolidation 等业务编排也复用，消除 subscribe 模板重复。

## 边界（什么搬、什么不搬）

| 内容 | 归属 | 原因 |
|---|---|---|
| prompt tail、默认工具、result extraction、是否能编辑画像 | `src/agent/agents/*` agent 类 | 这些是 agent 运行形态，是真正的 chatType 策略差异 |
| 是否进 `agent_sessions`、policy key、关闭时是否蒸馏、恢复算法 | `src/agent/harness.ts` 内的 `SESSION_LIFECYCLES` 表 | session 注册/关闭/蒸馏语义是 manager 的领域，不是 agent 业务 |
| daily/consolidation 的业务编排（查 episodes、拼 context、写 DB、发卡片、weekly summary） | `src/memory/daily-memory.ts` / `consolidation.ts` 保留 | agent 层不依赖 memory/lark/storage 具体业务，否则 `agent/` 又变大杂烩 |
| daily/consolidation 的 agent 运行形态（chatType / 工具集 / prompt 入口） | `src/agent/agents/daily-memory.ts` / `consolidation.ts` 新增 | 让 memory 层通过 `withOneShotAgent + Agent 子类` 调用，去掉手写 subscribe |

## 方案

### 目录结构

```
src/agent/
  service.ts              // AgentService: active agent 池 + lock + 恢复算法 + idle cleanup + one-shot runner
  harnessFactory.ts       // harness/session 文件装配 + SessionRegistry 注册/恢复
  runtime.ts              // AgentRuntime: BaseAgent 到 pi-agent-core harness 的薄壳
  toolCatalog.ts          // 内置工具全集 + 默认工具/恢复工具集解析
  base.ts                 // abstract Agent / abstract OneShotAgent + runForStream / runForFinalText / runForSideEffect
  agents/
    chat.ts               // ChatAgent (dm/topic/thread 三种 chatType 实例化)
    diary.ts              // DiaryAgent extends ChatAgent，覆写 promptTail
    distill.ts            // DistillAgent (一次性)
    knowledge-index.ts    // KnowledgeIndexAgent (一次性)
    consolidation.ts      // ConsolidationAgent / ConsolidationFriendAgent (一次性)
    daily-memory.ts       // DailyMemoryDreamAgent / DailyMemoryNudgeAgent (一次性)
    schedule.ts           // ScheduleAgent (一次性)
```

### Session lifecycle 表（留在 manager 内）

```ts
// harness.ts 内
interface SessionLifecycle {
  persistent: boolean;       // 是否进 agent_sessions
  policyKey?: keyof SessionPolicyConfig;  // 只 persistent=true 才有
  distillOnClose?: boolean;  // 只 persistent=true 才有
}

const SESSION_LIFECYCLES: Record<AgentChatType, SessionLifecycle> = {
  dm:              { persistent: true,  policyKey: "dm",     distillOnClose: true  },
  topic:           { persistent: true,  policyKey: "topic",  distillOnClose: true  },
  thread:          { persistent: true,  policyKey: "thread", distillOnClose: true  },
  diary:           { persistent: true,  policyKey: "diary",  distillOnClose: false },
  distill:         { persistent: false },
  schedule:        { persistent: false },
  knowledge_index: { persistent: false },
  daily_memory:    { persistent: false },
  consolidation:   { persistent: false },
};
```

替换掉现在的 `isPersistentChatType` / `policyKeyForChatType` / `shouldDistillOnClose` 三个函数。新增 chatType 改一张表，不再到处加分支。

### Agent 基类

```ts
abstract class Agent {
  abstract readonly chatType: AgentChatType;
  abstract readonly defaultTools: string[];

  /** 内置工具组：agent 声明自己需要的非通用工具组。manager 在 createEntry 时按声明追加。 */
  readonly toolGroups: ReadonlyArray<"profile_edit"> = [];

  abstract systemPrompt(): string | (() => string);

  // entry 由 manager 在创建后注入；agent 不知道 manager 存在
  protected entry!: HarnessEntry;
}

abstract class OneShotAgent extends Agent {
  // 一次性 agent 的结果提取 helper（也供 memory 层业务编排复用，通过 withOneShotAgent 暴露）
  protected async runForSideEffect(prompt: string): Promise<void>
  protected async runForFinalText(prompt: string): Promise<string>
  protected async runForStream(prompt: string, onDelta: (s: string) => void): Promise<string>
}
```

`toolGroups` 替换掉现在的 `canEditProfile`：ConsolidationAgent 声明 `toolGroups: ["profile_edit"]`，manager 看到这个能力声明就追加 `update_profile` / `set_chapter`。这样 manager 只检查 agent 的 capability 声明，不再做 `chatType === "consolidation"` 判断。

### ChatAgent 与 DiaryAgent

```ts
class ChatAgent extends Agent {
  constructor(
    readonly chatType: "dm" | "topic" | "thread",
    private promptTail: string,
    readonly defaultTools: string[],
  ) { super() }
  systemPrompt() { return () => buildBase() + this.promptTail }
}

class DiaryAgent extends ChatAgent {
  // 只覆写 promptTail
}
```

topic 和 thread 的 **prompt 和默认工具集** 相同，共用 ChatAgent 构造；**生命周期 policy 仍按 chatType 独立**（thread 默认 30 分钟自动关，topic 默认不自动关，见 `SESSION_LIFECYCLES`）。

### Registry：只收持久型

```ts
// agents/registry.ts
type PersistentChatType = "dm" | "topic" | "thread" | "diary";

export function chatAgentFor(chatType: PersistentChatType): ChatAgent {
  switch (chatType) {
    case "dm":     return new ChatAgent("dm", DM_TAIL, DM_TOOLS);
    case "topic":
    case "thread": return new ChatAgent(chatType, GROUP_TAIL, GROUP_TOOLS);
    case "diary":  return new DiaryAgent(...);
  }
}
```

一次性 agent 不进 registry，由各 runner 直接 `new`：

- `manager.runEpisodeDistill` → `new DistillAgent(source)`
- `manager.runKnowledgeIndexBuiltin` → `new KnowledgeIndexAgent(files)`
- `manager.runTask` → `new ScheduleAgent(opts)`
- `memory/daily-memory.ts` 业务编排 → `new DailyMemoryDreamAgent(...)` / `new DailyMemoryNudgeAgent(...)`
- `memory/consolidation.ts` 业务编排 → `new ConsolidationAgent(...)` / `new ConsolidationFriendAgent(...)`

类型上 `chatAgentFor` 只接 `PersistentChatType`，`pnpm build` 就能保证一次性类型不会被错传进来。

### 一次性 agent 的生命周期

agent 类不持有 manager 引用，由 manager 在外面包：

```ts
// harness.ts 上新增
async withOneShotAgent<A extends OneShotAgent, R>(
  buildAgent: () => A,
  fn: (agent: A) => Promise<R>,
): Promise<R> {
  // 1. 临时 scope + getOrCreate 不登记 registry
  // 2. 注入 entry 到 agent
  // 3. try { return await fn(agent) } finally { resetSession }
}
```

manager 上的三个 runner 改写：

```ts
runTask(prompt, opts) {
  return this.withOneShotAgent(
    () => new ScheduleAgent(opts),
    (agent) => agent.runFinalText(prompt),  // protected 在子类内调用
  );
}
```

memory 层业务编排也走同一入口：

```ts
// src/memory/daily-memory.ts
const dreamText = await harnessManager.withOneShotAgent(
  () => new DailyMemoryDreamAgent({ runId, context }),
  (agent) => agent.runStream(prompt, onDelta),
);
// 跑完后继续 memory 业务：写 daily_memory_runs、发卡片
```

注意：`runStream` / `runFinalText` / `runSideEffect` 在 `OneShotAgent` 内是 `protected`，子类可以暴露一个对应的 `public run*` 方法（薄包装、不掺业务逻辑），让外部 `withOneShotAgent` 的 fn 回调能调到。

## 决策

| 问题 | 决策 | 理由 |
|---|---|---|
| 纯数据 spec vs 类继承 | 类继承（Agent / OneShotAgent / ChatAgent / 各子类） | dm/topic/thread/diary 本质同一个 ChatAgent；后台 agent 的 subscribe 模板有真实重复，纯数据 spec 承载不了 |
| BaseAgent 是否持有 manager | 不持有，只持有 entry（由 manager 注入） | agent 类只描述「我是谁、用什么 prompt/工具、跑完拿什么结果」，不管自己的生命周期 |
| DiaryAgent 是否 extends ChatAgent | 是 | 底层都是「长期会话 + 工具集 + 拼 system prompt」，只 promptTail 不同 |
| topic / thread 是否合并 chatType | 不合并 | prompt 和默认工具相同（共用 ChatAgent 构造），但 lifecycle policy 不同（topic 不自动关，thread 30 分钟关）|
| HarnessManager 是否做到零 chatType 分支 | 否，只移走 agent 策略分支；lifecycle 分支用一张表集中 | lifecycle 是 manager 的领域，硬塞进 Agent 会让 agent 承担 registry 语义 |
| daily/consolidation 业务是否搬进 agents/ | 否，只搬运行形态，业务编排留在 `src/memory/*` | agent 层不依赖 memory/lark/storage；memory 层通过 `withOneShotAgent` 调 agent 子类 |
| `canEditProfile` 怎么表达 | agent 声明 `toolGroups: ["profile_edit"]`，manager 按 capability 追加内置工具 | 不再做 `chatType === "consolidation"` 判断 |
| Registry 是否覆盖所有 chatType | 否，只覆盖 `PersistentChatType`；一次性 agent 由 runner 直接 new | `pnpm build` 就能保证类型边界 |
| 一次性拆完 vs 分两步 | 一次性 | BaseAgent + `runFor*` helper 是一体的，分步会改两次中间态难看 |

## 不做

- 不引入 spec / interface / factory 层。`Agent` 抽象类够了，不需要 `IAgent` + `AgentSpec` 两层。
- 不改动调用方签名（cron / main / lark handler / consolidation / daily-memory / schedule）。`getOrCreateForMessage` / `runTask` / `runKnowledgeIndexBuiltin` / `compactSession` 等对外方法名和参数保持；新增的 `withOneShotAgent` 供 memory 层调用，旧的三个 runner 内部也用它。
- 不改 DB schema、不动 `agent_sessions` / `message_session_entries` 表结构、不动 `AgentChatType` 枚举。
- 不引入测试框架。本项目还没有 `pnpm test`，按惯例 `pnpm build` 类型检查作为 PR 前的最小验证。
- 不追求 HarnessManager 零 chatType 分支：lifecycle 分支用 `SESSION_LIFECYCLES` 表集中，保留在 manager 内。

## 验证

- `pnpm build` 通过。
- 结构性验证（命令行可复跑）：
  - `rg "harness\.subscribe" src/` —— 剩余订阅应只在飞书 lark handler 或 `OneShotAgent`/具体 agent 结果提取里，不再出现在 memory 层手写业务编排里。
  - `rg "appendSessionInstructions|activeToolNamesFor|policyKeyForChatType|shouldDistillOnClose|canEditProfile" src/agent` —— 不应再出现旧 harness 策略函数或 `canEditProfile`。
- 手动验证：DM 私聊、群 @ 话题、日记群三条主路径仍正常；`compactSession` / idle close / reply-target reopen / 进程重启恢复四条恢复路径仍按 20260628 设计走。
- 一次性 agent：distill / knowledge_index / consolidation / daily_memory / schedule 在 cron 触发的一轮里跑通。
