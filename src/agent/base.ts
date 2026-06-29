import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentChatType, SessionPolicyConfig } from "../config.js";
import type { DiaryService, EpisodeSource } from "../diary/service.js";
import type { MemoryService } from "../memory/service.js";
import type { MessageService, StoredMessage } from "../storage/messages.js";
import type { AgentCloseSegment, AgentRuntime } from "./runtime.js";

/** agent 声明的内置工具组；manager 看到声明就追加对应内置工具。 */
export type AgentToolGroup = "profile_edit";

export interface AgentCloseContext {
  diaryService: DiaryService;
  memoryService: MemoryService;
  messageService: MessageService;
  distill(source: EpisodeSource, messages: StoredMessage[]): Promise<void>;
}

/**
 * Agent 描述「我是谁、用什么 prompt、默认工具、需要哪些工具组」。
 * 不持有 service，由 service 在创建 harness 之后注入 runtime。
 */
export abstract class BaseAgent {
  abstract readonly chatType: AgentChatType;
  abstract readonly defaultTools: ReadonlyArray<string>;
  readonly toolGroups: ReadonlyArray<AgentToolGroup> = [];

  /** 静态字符串表示已经固定（多用于一次性 agent）；函数表示每次取 prompt 时重算。 */
  abstract systemPrompt(): string | (() => string);

  /** 返回非 null 表示这是可进入 SessionRegistry 的交互式会话。 */
  sessionPolicyKey(): keyof SessionPolicyConfig | null {
    return null;
  }

  /** 关闭 active agent 时由具体 agent 决定是否处理当前 segment。 */
  async onClose(ctx: AgentCloseContext): Promise<void> {
    const segment = this.runtime.consumeCloseSegment();
    if (segment) {
      await this.onCloseSegment(ctx, segment);
    }
  }

  /** 关闭 DB 中已存在但当前进程未激活的 segment。 */
  async onStoredSessionClose(
    ctx: AgentCloseContext,
    segment: AgentCloseSegment,
  ): Promise<void> {
    await this.onCloseSegment(ctx, segment);
  }

  protected async onCloseSegment(
    _ctx: AgentCloseContext,
    _segment: AgentCloseSegment,
  ): Promise<void> {
    // 默认关闭时无额外行为。
  }

  protected runtime!: AgentRuntime;

  /** 仅供 AgentService 在 harness 创建完成后注入 runtime。 */
  attach(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  prompt(input: string) {
    return this.runtime.prompt(input);
  }

  subscribe(...args: Parameters<AgentRuntime["subscribe"]>) {
    return this.runtime.subscribe(...args);
  }

  getModel() {
    return this.runtime.getModel();
  }

  getActiveTools() {
    return this.runtime.getActiveTools();
  }

  blockTools(names: string[], reason: string): void {
    this.runtime.blockTools(names, reason);
  }

  resetTools(): void {
    this.runtime.resetTools();
  }

  compact() {
    return this.runtime.compact();
  }

  setEpisodeSource(source: EpisodeSource | null): void {
    this.runtime.currentEpisodeSource = source;
  }

  recordActivity(occurredAt: string): void {
    this.runtime.recordActivity(occurredAt);
  }

  touchActivity(): void {
    this.runtime.touchActivity();
  }

  setRunId(runId: string | undefined): void {
    this.runtime.runId = runId;
  }

  get scopeId(): string {
    return this.runtime.scopeId;
  }

  get sessionRowId(): string | null {
    return this.runtime.sessionRowId;
  }

  get policyKey(): keyof SessionPolicyConfig | null {
    return this.runtime.sessionPolicyKey;
  }

  get lastActivityAt(): number {
    return this.runtime.lastActivityAt;
  }

  /** 调试 / 业务侧需要知道实际跑的模型 id（写 agent_runs 表等场景）。 */
  get modelId(): string {
    return this.runtime.modelId;
  }
}

/**
 * 一次性 agent：跑完即丢的 scope；子类暴露 public 入口（薄包装），
 * 业务编排在外层（manager 自带的 runner 或 memory 层）通过 withOneShotAgent 调进来。
 *
 * 子类用 `scopeName` 区分临时 scope 命名（例如 ConsolidationAgent 主轮 = "consolidation"，
 * friend 轮 = "consolidation_friend"）。`profileName` / `extraTools` 让 manager 不必
 * `instanceof` 判断 ScheduleAgent 就能拿到定时任务携带的画像和自定义工具。
 */
export abstract class OneShotAgent extends BaseAgent {
  /** 临时 scope 命名前缀；与 runId 拼成 `${scopeName}_${runId}`。 */
  abstract readonly scopeName: string;
  /** 可选：用 caller 指定的 model profile 覆盖 chatType 默认档位。 */
  readonly profileName?: string;
  /** 可选：caller 注入的自定义工具（schedule 等场景）。 */
  readonly extraTools?: ReadonlyArray<AgentTool<any>>;

  /** 只 await prompt，不抓任何结果。 */
  protected async runForSideEffect(prompt: string): Promise<void> {
    await this.runtime.prompt(prompt);
  }

  /** 抓最后一轮 assistant 消息（无 toolCall）的纯文本。 */
  protected async runForFinalText(prompt: string): Promise<string> {
    let text = "";
    const unsubscribe = this.runtime.subscribe(async (event) => {
      if (event.type === "turn_end" && !assistantMessageHasToolCall(event.message)) {
        text = assistantMessageText(event.message);
      }
    });
    try {
      await this.runtime.prompt(prompt);
      return text.trim();
    } finally {
      unsubscribe();
    }
  }

  /**
   * 拼接所有 message_update.text_delta 流出来的 delta，返回最终累加文本。
   * 如果需要在流过程中观察 delta，可传 onDelta；默认只静默累加。
   */
  protected async runForStream(
    prompt: string,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    let captured = "";
    const unsubscribe = this.runtime.subscribe(async (event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        captured += event.assistantMessageEvent.delta;
        onDelta?.(event.assistantMessageEvent.delta);
      }
    });
    try {
      await this.runtime.prompt(prompt);
      return captured.trim();
    } finally {
      unsubscribe();
    }
  }
  /**
   * 跑一轮 prompt 并捕获指定工具的最后一次成功 result。
   * 用于 nudge 这类「只关心某个工具是否成功执行」的一次性 agent。
   * 主轮 consolidation 那种「每次 tool_execution_end 后重置」的特殊语义不要套这个 helper，保留原始 subscribe。
   */
  protected async runForToolResult<T = unknown>(
    prompt: string,
    toolName: string,
  ): Promise<T | null> {
    let captured: T | null = null;
    const unsubscribe = this.runtime.subscribe(async (event) => {
      if (
        event.type !== "tool_execution_end" ||
        event.toolName !== toolName ||
        event.isError
      ) {
        return;
      }
      captured = event.result as T;
    });
    try {
      await this.runtime.prompt(prompt);
      return captured;
    } finally {
      unsubscribe();
    }
  }
}

export { BaseAgent as Agent };

function assistantMessageHasToolCall(message: unknown): boolean {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const record = item as Record<string, unknown>;
    return record?.type === "toolCall";
  });
}

function assistantMessageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const record = item as Record<string, unknown>;
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
}
