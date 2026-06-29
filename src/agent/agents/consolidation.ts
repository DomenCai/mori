import { OneShotAgent } from "../base.js";
import { buildMemorySnapshot, buildSystemPrompt } from "../prompts.js";
import type { MemoryService } from "../../memory/service.js";
import type Database from "better-sqlite3";

export type ConsolidationRound = "main" | "friend";

/**
 * 周度合并 agent。主轮跑 mechanicalPrompt（runMain），friend 轮跑 friendPrompt（runFriend），
 * 共用同一个 chatType；toolGroups: profile_edit 让 manager 追加 update_profile / set_chapter。
 *
 * 主轮和 friend 轮的差异只在 defaultTools、prompt 与 scope 命名；业务编排
 * （episodes 收集、card 渲染、weekly_summaries 写库）仍在 memory/consolidation.ts。
 */
export class ConsolidationAgent extends OneShotAgent {
  readonly chatType = "consolidation" as const;
  readonly toolGroups = ["profile_edit"] as const;
  readonly scopeName: "consolidation" | "consolidation_friend";

  constructor(
    readonly defaultTools: ReadonlyArray<string>,
    private readonly db: Database.Database,
    private readonly memoryService: MemoryService,
    round: ConsolidationRound = "main",
  ) {
    super();
    this.scopeName = round === "friend" ? "consolidation_friend" : "consolidation";
  }

  systemPrompt(): () => string {
    return () => {
      this.memoryService.syncEditableMemoryFiles();
      const snapshot = buildMemorySnapshot(this.db, this.memoryService);
      return buildSystemPrompt(snapshot);
    };
  }

  /**
   * 主轮：抓最后一段 text_delta（每次 tool_execution_end 后重置），返回累加文本。
   * 业务侧再用 <weekly_record> 标签提取周记录正文。
   */
  async runMain(prompt: string): Promise<string> {
    let captured = "";
    const unsubscribe = this.subscribe(async (event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        captured += event.assistantMessageEvent.delta;
      }
      if (event.type === "tool_execution_end") {
        captured = "";
      }
    });
    try {
      await this.prompt(prompt);
      return captured.trim();
    } finally {
      unsubscribe();
    }
  }

  /** Friend 轮：纯文本输出，无工具调用。 */
  async runFriend(prompt: string): Promise<string> {
    return this.runForStream(prompt);
  }
}
