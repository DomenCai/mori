import { Agent } from "../base.js";
import { buildMemorySnapshot, buildSystemPrompt } from "../prompts.js";
import { isWebSearchConfigured } from "../tools/web-search.js";
import type { AgentCloseContext } from "../base.js";
import type { AgentCloseSegment } from "../runtime.js";
import type { MemoryService } from "../../memory/service.js";
import type Database from "better-sqlite3";
import type { SessionPolicyConfig } from "../../config.js";
import type { StoredMessage } from "../../storage/messages.js";
import type { EpisodeSource } from "../../diary/service.js";

const MIN_DISTILL_USER_CHARS = 80;

const DM_GROUP_TAIL = `

---
# 当前会话工具纪律
- 持续叙事线由 daily_memory 统一维护；普通对话不要直接写 storylines。
- 如用户明确要求收藏 URL，可先 fetch_article 再 save_to_garden。
{EXTERNAL_FACTS}
- DM、主题群和话题中，当前话题明显可能命中已有知识时可以 grep_vault / read_vault，回答要短，不要整段搬运原文。
- 反应和普通对话蒸馏只写 episode，绝不修改身份画像。`;

function externalFactsInstruction(): string {
  return isWebSearchConfigured()
    ? "- 对不熟或可能过期的外部事实，先 web_search；对象是 URL 时用 fetch_article。"
    : "- 对象是 URL 时可用 fetch_article；未配置 web_search 时不要尝试网页搜索。";
}

export function buildChatTail(): string {
  return DM_GROUP_TAIL.replace("{EXTERNAL_FACTS}", externalFactsInstruction());
}

export function defaultChatTools(): string[] {
  // 普通对话不写 episode（蒸馏交给独立 distill agent），所以工具集里不含 write_episode。
  const tools = [
    "search_memory",
    "fetch_article",
    "save_to_garden",
    "grep_vault",
    "read_vault",
    "update_frontmatter",
    "promote",
  ];
  if (isWebSearchConfigured()) {
    tools.splice(1, 0, "web_search");
  }
  return tools;
}

/**
 * dm / topic / thread 三种长会话的共享形态：
 * prompt 和默认工具相同；session policy key 仍按 chatType 独立。
 */
export class ChatAgent extends Agent {
  readonly defaultTools: string[];

  constructor(
    readonly chatType: "dm" | "topic" | "thread",
    private readonly db: Database.Database,
    private readonly memoryService: MemoryService,
  ) {
    super();
    this.defaultTools = defaultChatTools();
  }

  systemPrompt(): () => string {
    return () => {
      this.memoryService.syncEditableMemoryFiles();
      const snapshot = buildMemorySnapshot(this.db, this.memoryService);
      return buildSystemPrompt(snapshot) + buildChatTail();
    };
  }

  sessionPolicyKey(): keyof SessionPolicyConfig {
    return this.chatType;
  }

  protected async onCloseSegment(
    ctx: AgentCloseContext,
    segment: AgentCloseSegment,
  ): Promise<void> {
    const source: EpisodeSource = {
      conversationId: segment.scopeId,
      messageId: null,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
    };

    if (ctx.diaryService.hasEpisodeForScopeWindow(source)) return;
    const messages = ctx.messageService.getConversationMessages(
      source.conversationId,
      source.startedAt,
      source.endedAt,
    );
    if (!segmentWorthDistilling(messages)) return;

    try {
      await ctx.distill(source, messages);
    } catch {
      // 原始 messages 表已留底；蒸馏失败时不写兜底 episode，避免污染检索层。
    }
  }
}

function segmentWorthDistilling(messages: StoredMessage[]): boolean {
  const userChars = messages
    .filter((message) => message.role === "user")
    .reduce((sum, message) => sum + message.content.trim().length, 0);
  return userChars >= MIN_DISTILL_USER_CHARS;
}
