// 飞书消息 → harness 驱动 → 流式卡片回复。日记群、普通会话、话题和通知反应分流处理。
import type {
  LarkChannel,
  NormalizedMessage,
  SendOptions,
} from "@larksuite/channel";
import { HarnessManager, type HarnessEntry } from "../agent/harness.js";
import type { EpisodeSource } from "../diary/service.js";
import { distillDiaryEntry } from "../diary/distill.js";
import type { IngestedMessage } from "../ingest/message.js";
import { larkMessageId } from "./ingest.js";
import { formatLensPrompt, type ParsedLens } from "./lenses.js";
import { isWebSearchConfigured } from "../agent/tools/web-search.js";
import { createAgentCardState, renderAgentCard } from "./cards.js";
import {
  appendCardText,
  startCardTool,
  finishCardTool,
  updateAgentCard,
  extractTotalTokens,
  getAssistantError,
  formatError,
} from "./agentCardEvents.js";
import { logger } from "../log.js";
import { nowISO } from "../utils.js";

const larkLog = logger("lark");
const diaryLog = logger("diary");

interface StreamAgentReplyOutcome {
  promptError?: string | null;
  successStatus?: string;
  errorStatus?: string;
}

async function streamAgentReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  entry: HarnessEntry,
  runPrompt: () => Promise<StreamAgentReplyOutcome | void>,
  log: typeof larkLog,
): Promise<{ messageId: string; assistantText: string }> {
  let assistantText = "";
  const started = Date.now();
  const sent = await channel.stream(
    msg.chatId,
    {
      card: {
        initial: renderAgentCard(createAgentCardState()),
        producer: async (ctrl) => {
          const cardState = createAgentCardState();
          let promptError: string | null = null;
          let outcome: StreamAgentReplyOutcome = {};
          let lastTotalTokens = 0;

          const unsubscribe = entry.harness.subscribe(async (event) => {
            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_delta"
            ) {
              assistantText += event.assistantMessageEvent.delta;
              appendCardText(cardState, event.assistantMessageEvent.delta);
              await ctrl.update(renderAgentCard(cardState));
            }
            if (event.type === "tool_execution_start") {
              startCardTool(cardState, event);
              await updateAgentCard(ctrl, cardState, { yieldForPatch: true });
            }
            if (event.type === "tool_execution_end") {
              finishCardTool(cardState, event);
              await updateAgentCard(ctrl, cardState, { yieldForPatch: true });
            }
            if (event.type === "turn_end") {
              promptError = getAssistantError(event.message);
              lastTotalTokens = extractTotalTokens(event.message);
            }
          });

          try {
            try {
              outcome = await runPrompt() ?? {};
              promptError = outcome.promptError ?? promptError;
            } catch (err) {
              promptError = formatError(err);
              log.error("prompt 失败:", err);
            }

            const elapsed = Date.now() - started;
            const metrics = {
              totalTokens: lastTotalTokens,
              contextWindow: entry.harness.getModel().contextWindow,
              elapsedMs: elapsed,
            };

            if (promptError) {
              log.warn(`回复失败 chat=${msg.chatId} 耗时=${elapsed}ms: ${promptError}`);
              cardState.terminal = "error";
              cardState.footer = null;
              cardState.status = outcome.errorStatus ?? `> 处理失败：${promptError}`;
              cardState.metrics = metrics;
              await ctrl.update(renderAgentCard(cardState));
              return;
            }

            log.info(`回复完成 chat=${msg.chatId} 耗时=${elapsed}ms`);
            cardState.terminal = "done";
            cardState.footer = null;
            cardState.status = outcome.successStatus;
            cardState.metrics = metrics;
            await ctrl.update(renderAgentCard(cardState));
          } finally {
            unsubscribe();
          }
        },
      },
    },
    replyOptions(msg),
  );

  return {
    messageId: sent.messageId,
    assistantText,
  };
}

export function isDiaryEntryMessage(msg: NormalizedMessage): boolean {
  return !msg.replyToMessageId && !msg.rootId;
}

export async function handleDiaryMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  mode: "entry" | "reply",
): Promise<void> {
  const scopeId = message.conversationId;
  const entry = await harnessManager.getOrCreate(scopeId, "diary");
  const messageService = harnessManager.getMessageService();
  const messageTime = message.occurredAt;
  if (mode === "reply") {
    messageService.saveUserMessage(message);
  }
  harnessManager.recordActivity(scopeId, messageTime);

  // 日记 scope 工具集恒定 [write_episode, search_memory]，不切工具（切了会炸缓存）。
  // 追问轮硬拦 write_episode；新日记轮放行（蒸馏需要它）。
  if (mode === "reply") {
    entry.toolGuard.block(["write_episode"], "日记追问轮不写 episode");
  } else {
    entry.toolGuard.reset();
  }

  diaryLog.info(
    mode === "entry"
      ? `处理日记 conversation=${message.conversationId} messageId=${message.id}`
      : `处理日记回复 chat=${msg.chatId} replyTo=${msg.replyToMessageId ?? "unknown"}`,
  );

  const sent = await (async () => {
    try {
      return await streamAgentReply(
        channel,
        msg,
        entry,
        async () => {
          if (mode === "entry") {
            const episodeResult = await distillDiaryEntry({
              harnessManager,
              message,
            });
            return {
              promptError: episodeResult.promptError ?? null,
              successStatus: episodeResult.fallbackReason
                ? `> ${episodeResult.fallbackReason}`
                : undefined,
              errorStatus: episodeResult.fallbackReason
                ? `> ${episodeResult.fallbackReason}`
                : episodeResult.promptError
                  ? `> 处理失败，已保存原文和兜底 episode：${episodeResult.promptError}`
                  : undefined,
            };
          }
          await entry.harness.prompt(
            await formatDiaryPrompt(message, harnessManager),
          );
          return undefined;
        },
        diaryLog,
      );
    } finally {
      entry.currentEpisodeSource = null;
    }
  })();

  messageService.saveAssistantMessage({
    id: larkMessageId(sent.messageId)!,
    source: "lark",
    conversationId: message.conversationId,
    conversationType: message.conversationType,
    content: sent.assistantText || "（卡片回复）",
    replyTo: message.id,
    threadId: message.threadId,
    rootId: message.rootId,
  });
}

export async function handleChatMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: "dm" | "topic" | "thread",
): Promise<void> {
  const scopeId = message.conversationId;
  const entry = await harnessManager.getOrCreate(scopeId, chatType);
  const messageService = harnessManager.getMessageService();
  const messageTime = message.occurredAt;
  messageService.saveUserMessage(message);
  harnessManager.recordActivity(scopeId, messageTime);
  await promoteKnowledgeIfNeeded(message, harnessManager);
  larkLog.info(`处理对话 scope=${scopeId} type=${chatType}`);

  const sent = await streamAgentReply(
    channel,
    msg,
    entry,
    async () => {
      await entry.harness.prompt(
        await formatChatPrompt(message, harnessManager),
      );
    },
    larkLog,
  );

  messageService.saveAssistantMessage({
    id: larkMessageId(sent.messageId)!,
    source: "lark",
    conversationId: message.conversationId,
    conversationType: message.conversationType,
    content: sent.assistantText || "（卡片回复）",
    replyTo: message.id,
    threadId: message.threadId,
    rootId: message.rootId,
  });
}

export async function handleLensMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: "dm" | "topic" | "thread",
  lens: ParsedLens,
): Promise<void> {
  const target = lens.body || buildLensReplyTarget(message, harnessManager);
  if (!target) {
    await channel.send(
      msg.chatId,
      { text: "命令后面给内容，或回复某条消息" },
      replyOptions(msg),
    );
    return;
  }

  const scopeId = message.conversationId;
  const entry = await harnessManager.getOrCreate(scopeId, chatType);
  const messageService = harnessManager.getMessageService();
  messageService.saveUserMessage(message);
  harnessManager.recordActivity(scopeId, message.occurredAt);
  larkLog.info(`处理 lens scope=${scopeId} type=${chatType} lens=${lens.lens}`);

  // 透镜轮只放行 lens 允许的工具，但不切工具集（切了会炸活跃会话的缓存），
  // 改成把其余工具拦在调用层。
  const allowed = new Set(lensToolNames(lens));
  const blocked = entry.harness
    .getActiveTools()
    .map((tool) => tool.name)
    .filter((name) => !allowed.has(name));

  try {
    entry.toolGuard.block(blocked, "思考透镜轮只用该透镜允许的工具");
    const sent = await streamAgentReply(
      channel,
      msg,
      entry,
      async () => {
        await entry.harness.prompt(formatLensPrompt(lens.lens, target));
      },
      larkLog,
    );

    messageService.saveAssistantMessage({
      id: larkMessageId(sent.messageId)!,
      source: "lark",
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      content: sent.assistantText || "（卡片回复）",
      replyTo: message.id,
      threadId: message.threadId,
      rootId: message.rootId,
    });
  } finally {
    entry.toolGuard.reset();
  }
}

function lensToolNames(lens: ParsedLens): string[] {
  if (lens.lens !== "plain") return [];
  return isWebSearchConfigured() ? ["web_search", "fetch_article"] : ["fetch_article"];
}

export async function handleNotificationMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
): Promise<boolean> {
  if (msg.threadId) {
    return false;
  }
  const messageService = harnessManager.getMessageService();
  messageService.saveUserMessage(message);
  if (!msg.replyToMessageId) {
    await channel.send(msg.chatId, {
      text: "通知群只捕获对知识卡片的回复；要深聊请用话题回复。",
    });
    return true;
  }

  const parent = message.replyTo
    ? messageService.get(message.replyTo)
    : null;
  if (!parent?.knowledge_path) return false;

  const nextPath = await promoteKnowledgeIfNeeded(message, harnessManager);
  const source: EpisodeSource = {
    conversationId: message.conversationId,
    messageId: message.id,
    startedAt: message.occurredAt,
    endedAt: message.occurredAt,
  };
  harnessManager.getDiaryService().saveFallbackEpisode(
    source,
    `用户对知识卡片 ${nextPath ?? parent.knowledge_path} 的反应：${message.content}`,
  );

  const sent = await channel.send(msg.chatId, {
    text: "已收藏，并记下你的看法。",
  }, { replyTo: msg.messageId });
  messageService.saveAssistantMessage({
    id: larkMessageId(sent.messageId)!,
    source: "lark",
    conversationId: message.conversationId,
    conversationType: message.conversationType,
    content: "已收藏，并记下你的看法。",
    replyTo: message.id,
  });
  return true;
}

async function formatDiaryPrompt(
  message: IngestedMessage,
  harnessManager: HarnessManager,
): Promise<string> {
  const replyContext = buildReplyContext(message, harnessManager);

  return `${replyContext}<diary_followup>
这是同一篇日记里的继续回复，不是新日记：本轮不要调用 write_episode，也不要把它当成新日记入库。保持日记群的陪伴语气和上下文连续性。
</diary_followup>

<my_message>
${message.content}
</my_message>`;
}

async function formatChatPrompt(
  message: IngestedMessage,
  harnessManager: HarnessManager,
): Promise<string> {
  return `${buildReplyContext(message, harnessManager)}<my_message>
${message.content}
</my_message>`;
}

export function buildReplyContext(
  message: IngestedMessage,
  harnessManager: HarnessManager,
): string {
  const contextMessageId = message.replyTo ?? message.rootId;
  if (!contextMessageId) return "";
  const parent = harnessManager.getMessageService().get(contextMessageId);
  if (!parent) return "";
  const knowledge = parent.knowledge_path
    ? `这是对知识卡片的回应，对应知识文件：${parent.knowledge_path}\n`
    : "";
  return `<replied_message>
${knowledge}${parent.content}
</replied_message>

`;
}

function buildLensReplyTarget(
  message: IngestedMessage,
  harnessManager: HarnessManager,
): string {
  const contextMessageId = message.replyTo ?? message.rootId;
  if (!contextMessageId) return "";
  const parent = harnessManager.getMessageService().get(contextMessageId);
  return parent?.content.trim() ?? "";
}

async function promoteKnowledgeIfNeeded(
  message: IngestedMessage,
  harnessManager: HarnessManager,
): Promise<string | null> {
  if (!message.replyTo) return null;
  const messageService = harnessManager.getMessageService();
  const parent = messageService.get(message.replyTo);
  if (!parent?.knowledge_path) return null;

  const nextPath = harnessManager.getVaultService().promote(parent.knowledge_path, {
    my_note: message.content,
    reacted_at: message.occurredAt || nowISO(),
  });
  messageService.updateKnowledgePath(parent.id, nextPath);
  return nextPath;
}

function replyOptions(msg: NormalizedMessage): SendOptions {
  return {
    replyTo: msg.messageId,
    replyInThread: !!msg.threadId,
  };
}
