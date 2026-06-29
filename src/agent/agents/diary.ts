import { Agent } from "../base.js";
import { buildMemorySnapshot, buildSystemPrompt } from "../prompts.js";
import type { MemoryService } from "../../memory/service.js";
import type Database from "better-sqlite3";
import type { SessionPolicyConfig } from "../../config.js";

const DIARY_TAIL = `

---
# 当前会话：日记群
- 用户消息会带有场景标记：
  - [日记群新日记]：这是一条新的日记根消息，必须先调用 write_episode 工具把原文蒸馏成 episode。
  - [日记群追问]：这是用户在同一篇日记上下文里继续回复，不是新的日记；不要求调用 write_episode。
- 持续叙事线由 daily_memory 统一维护；当前会话只写 episode、必要时 search_memory。
- 对 [日记群新日记]，在完成必要工具调用前不要输出面向用户的回复文本；工具完成后再按 response_style 回应，长短随内容走，不强求简短也不硬凑长。
- 对 [日记群追问]，可以直接自然回复；需要检索时再调用 search_memory。
- 回应时：
  - 一篇日记里塞了好几件事，挑一两件最有嚼头的往深里走，其余至多带过，别每件都回一句。覆盖全等于偷懒。
  - 问问题要克制。看到盲点直接点出来，那是陈述不算提问；提问只在一个问题真能帮我往下想时才用，别每条都用问号收尾、也别一次摞一串。
  - 默认不给方案、不给清单、不把我的处境重构成「你要解决的问题」。只有我明显卡死、或这篇本身在问怎么办时，给一个最小、具体的下一步，只给一个。日记不是任务列表。`;

export class DiaryAgent extends Agent {
  readonly chatType = "diary" as const;
  readonly defaultTools = ["write_episode", "search_memory"] as const;

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
      return buildSystemPrompt(snapshot) + DIARY_TAIL;
    };
  }

  sessionPolicyKey(): keyof SessionPolicyConfig {
    return "diary";
  }
}
