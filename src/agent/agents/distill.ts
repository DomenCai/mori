import { OneShotAgent } from "../base.js";
import { buildMemorySnapshot, buildSystemPrompt } from "../prompts.js";
import type { EpisodeSource } from "../../diary/service.js";
import type { MemoryService } from "../../memory/service.js";
import type { StoredMessage } from "../../storage/messages.js";
import type Database from "better-sqlite3";

/**
 * 会话片段蒸馏：跑在独立的一次性 agent 里（工具集恒定 [write_episode]），
 * 不劫持正在对话的 harness，蒸馏只读用户消息和我的回复文本，不掺工具调用噪音。
 */
export class DistillAgent extends OneShotAgent {
  readonly chatType = "distill" as const;
  readonly scopeName = "distill" as const;
  readonly defaultTools = ["write_episode"] as const;

  constructor(
    public readonly source: EpisodeSource,
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

  async run(messages: StoredMessage[]): Promise<void> {
    this.setEpisodeSource(this.source);
    const transcript = messages
      .map(
        (m) =>
          `[${m.occurred_at}] ${m.role === "user" ? "用户" : "我"}: ${m.content}`,
      )
      .join("\n\n");
    await this.runForSideEffect(`# 会话片段蒸馏

下面是一段已经结束的对话，只含用户消息和我的回复。请判断其中是否有和用户长期上下文有关的事实、判断、行动、偏好信号：
- 有，就只调用 write_episode 蒸馏成一条 episode（每条 observation 带原文 evidence）。
- 没有值得长期记的内容，就什么工具都不要调用，直接结束。
不要输出面向用户的回复文本，不要修改身份画像。

${transcript}`);
  }
}
