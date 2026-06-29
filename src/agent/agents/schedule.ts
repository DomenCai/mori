import type { AgentTool } from "@earendil-works/pi-agent-core";
import { OneShotAgent } from "../base.js";

export type TaskSystemPrompt = "bare" | "mori" | string;

/**
 * Schedule（定时任务）agent：完全由调用方注入 system prompt / tools / profile。
 * 没有持久记忆语义。
 */
export class ScheduleAgent extends OneShotAgent {
  readonly chatType = "schedule" as const;
  readonly scopeName = "schedule" as const;
  readonly defaultTools: ReadonlyArray<string>;
  readonly extraTools: ReadonlyArray<AgentTool<any>>;
  readonly profileName: string | undefined;
  private readonly system: string;

  constructor(opts: {
    system: string;
    profileName?: string;
    /** 工具名列表（已校验合法）。 */
    activeToolNames: string[];
    /** 自定义工具（caller 自带的 AgentTool 对象）。 */
    extraTools: AgentTool<any>[];
  }) {
    super();
    this.system = opts.system;
    this.profileName = opts.profileName;
    this.defaultTools = opts.activeToolNames;
    this.extraTools = opts.extraTools;
  }

  systemPrompt(): string {
    return this.system;
  }

  async run(prompt: string): Promise<string> {
    return this.runForFinalText(prompt);
  }
}
