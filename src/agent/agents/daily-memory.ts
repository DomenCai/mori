import { OneShotAgent } from "../base.js";
import { buildMemorySnapshot, buildSystemPrompt } from "../prompts.js";
import type { MemoryService } from "../../memory/service.js";
import type Database from "better-sqlite3";

/**
 * daily_memory / dream_agent：维护 storylines。
 * 不变量：dream 永远不能激活 send_checkin；nudge 永远不能激活写记忆工具。
 */
export class DailyMemoryDreamAgent extends OneShotAgent {
  readonly chatType = "daily_memory" as const;
  readonly scopeName = "daily_memory_dream" as const;
  readonly defaultTools = [
    "search_memory",
    "get_storyline",
    "create_storyline",
    "advance_storyline",
    "set_storyline_status",
    "merge_storylines",
  ] as const;

  constructor(
    private readonly db: Database.Database,
    private readonly memoryService: MemoryService,
  ) {
    super();
  }

  systemPrompt(): () => string {
    return () => {
      this.memoryService.syncEditableMemoryFiles();
      const snapshot = buildMemorySnapshot(this.db, this.memoryService);
      return buildSystemPrompt(snapshot);
    };
  }

  async run(prompt: string): Promise<string> {
    return this.runForStream(prompt);
  }
}

/** daily_memory / nudge_agent：只能调 send_checkin 或不调任何工具。 */
export class DailyMemoryNudgeAgent extends OneShotAgent {
  readonly chatType = "daily_memory" as const;
  readonly scopeName = "daily_memory_nudge" as const;
  readonly defaultTools = ["send_checkin"] as const;

  constructor(
    private readonly db: Database.Database,
    private readonly memoryService: MemoryService,
  ) {
    super();
  }

  systemPrompt(): () => string {
    return () => {
      this.memoryService.syncEditableMemoryFiles();
      const snapshot = buildMemorySnapshot(this.db, this.memoryService);
      return buildSystemPrompt(snapshot);
    };
  }

  /**
   * 监听 send_checkin 工具结果，返回是否真发出、以及发出的文本。
   * 业务层用此结果落 daily_memory_runs。
   */
  async run(prompt: string): Promise<{ sent: boolean; text: string | null }> {
    const result = await this.runForToolResult<{ details?: unknown }>(
      prompt,
      "send_checkin",
    );
    const details = result?.details;
    if (!details || typeof details !== "object") {
      return { sent: false, text: null };
    }
    const record = details as Record<string, unknown>;
    return {
      sent: record.sent === true,
      text: typeof record.text === "string" ? record.text : null,
    };
  }
}
