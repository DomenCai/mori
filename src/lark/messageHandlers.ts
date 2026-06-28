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
): Promise<{ messageId: string; assistantText: string; messageIds: string[]; texts: string[] }> {
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
    messageIds: [sent.messageId],
    texts: [assistantText],
  };
}

// 一条 assistant 消息里的文本块拼起来；非 assistant 或无文本返回空串。
function assistantMessageText(message: unknown): string {
  const msg = message as { role?: unknown; content?: unknown };
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
  return msg.content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("")
    .trim();
}

// DM 不流式，且每条 assistant 消息单独发：像真人一条条蹦消息。一轮里 agent
// 可能先说"让我查一下"、调工具、再给答案——每条 message_end 就即时发一条。
async function sendAgentReplyText(
  channel: LarkChannel,
  msg: NormalizedMessage,
  entry: HarnessEntry,
  runPrompt: () => Promise<StreamAgentReplyOutcome | void>,
  log: typeof larkLog,
): Promise<{ messageId: string; assistantText: string; messageIds: string[]; texts: string[] }> {
  const texts: string[] = [];
  const messageIds: string[] = [];
  let lastMessageId = "";
  let promptError: string | null = null;
  const started = Date.now();

  const unsubscribe = entry.harness.subscribe(async (event) => {
    if (event.type === "message_end") {
      const text = assistantMessageText(event.message);
      if (text) {
        texts.push(text);
        const sent = await channel.send(msg.chatId, { markdown: text });
        lastMessageId = sent.messageId;
        messageIds.push(sent.messageId);
      }
    }
    if (event.type === "turn_end") {
      promptError = getAssistantError(event.message) ?? promptError;
    }
  });

  try {
    const outcome = (await runPrompt()) ?? {};
    promptError = outcome.promptError ?? promptError;
  } catch (err) {
    promptError = formatError(err);
    log.error("prompt 失败:", err);
  } finally {
    unsubscribe();
  }

  const elapsed = Date.now() - started;
  log[promptError ? "warn" : "info"](
    `回复${promptError ? "失败" : "完成"} chat=${msg.chatId} 耗时=${elapsed}ms`,
  );

  if (promptError) {
    const sent = await channel.send(
      msg.chatId,
      { text: texts.length ? `（出错了：${promptError}）` : `处理失败：${promptError}` },
      replyOptions(msg),
    );
    lastMessageId = sent.messageId;
    messageIds.push(sent.messageId);
  } else if (!texts.length) {
    const sent = await channel.send(msg.chatId, { text: "…" }, replyOptions(msg));
    lastMessageId = sent.messageId;
    messageIds.push(sent.messageId);
  }

  return {
    messageId: lastMessageId,
    assistantText: texts.join("\n\n"),
    messageIds,
    texts,
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
  await harnessManager.withScopeLock(scopeId, () =>
    handleDiaryMessageInLock(msg, message, channel, harnessManager, mode),
  );
}

async function handleDiaryMessageInLock(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  mode: "entry" | "reply",
): Promise<void> {
  const scopeId = message.conversationId;
  const entry = await harnessManager.getOrCreateForMessageInLock(scopeId, "diary", message);
  const messageService = harnessManager.getMessageService();
  const messageTime = message.occurredAt;
  if (mode === "reply") {
    messageService.saveUserMessage(message);
    harnessManager.recordUserMessage(scopeId, message.id, message.occurredAt);
  } else {
    // entry 模式下 distillDiaryEntry 内部会 saveUserMessage，但 message_session_entries
    // 仍要由 handler 这层来登记，确保未来回复这条日记 anchor 时能命中 session。
    harnessManager.recordUserMessage(scopeId, message.id, message.occurredAt);
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

  const assistantOccurredAt = nowISO();
  // DM 多条消息：每条单独存 messages 表 + 登记 message_session_entries，
  // 让用户未来回复任意一条都能定位到原 session。
  for (let i = 0; i < sent.messageIds.length; i++) {
    const id = larkMessageId(sent.messageIds[i])!;
    const text = sent.texts[i] ?? sent.assistantText ?? "（卡片回复）";
    messageService.saveAssistantMessage({
      id,
      source: "lark",
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      content: text || "（卡片回复）",
      replyTo: message.id,
      threadId: message.threadId,
      rootId: message.rootId,
      occurredAt: assistantOccurredAt,
    });
    harnessManager.recordAssistantMessage(scopeId, id, assistantOccurredAt);
  }
}

export async function handleChatMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: "dm" | "topic" | "thread",
): Promise<void> {
  const scopeId = message.conversationId;
  await harnessManager.withScopeLock(scopeId, () =>
    handleChatMessageInLock(msg, message, channel, harnessManager, chatType),
  );
}

async function handleChatMessageInLock(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: "dm" | "topic" | "thread",
): Promise<void> {
  const scopeId = message.conversationId;
  const entry = await harnessManager.getOrCreateForMessageInLock(scopeId, chatType, message);
  const messageService = harnessManager.getMessageService();
  const messageTime = message.occurredAt;
  messageService.saveUserMessage(message);
  harnessManager.recordUserMessage(scopeId, message.id, message.occurredAt);
  harnessManager.recordActivity(scopeId, messageTime);
  await promoteKnowledgeIfNeeded(message, harnessManager);
  larkLog.info(`处理对话 scope=${scopeId} type=${chatType}`);

  const stream = chatType === "dm" ? sendAgentReplyText : streamAgentReply;
  const sent = await stream(
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

  const assistantOccurredAt = nowISO();
  // sendAgentReplyText 可能发出多条飞书消息（DM 一条条蹦）：每条都登记，
  // 这样用户未来回复任意一条都能命中原 session。streamAgentReply 只有一条卡片，messageIds 长度恒为 1。
  for (let i = 0; i < sent.messageIds.length; i++) {
    const id = larkMessageId(sent.messageIds[i])!;
    const text = sent.texts[i] ?? sent.assistantText ?? "（卡片回复）";
    messageService.saveAssistantMessage({
      id,
      source: "lark",
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      content: text || "（卡片回复）",
      replyTo: message.id,
      threadId: message.threadId,
      rootId: message.rootId,
      occurredAt: assistantOccurredAt,
    });
    harnessManager.recordAssistantMessage(scopeId, id, assistantOccurredAt);
  }
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
  await harnessManager.withScopeLock(scopeId, () =>
    handleLensMessageInLock(msg, message, channel, harnessManager, chatType, lens, target),
  );
}

async function handleLensMessageInLock(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: "dm" | "topic" | "thread",
  lens: ParsedLens,
  target: string,
): Promise<void> {
  const scopeId = message.conversationId;
  const entry = await harnessManager.getOrCreateForMessageInLock(scopeId, chatType, message);
  const messageService = harnessManager.getMessageService();
  messageService.saveUserMessage(message);
  harnessManager.recordUserMessage(scopeId, message.id, message.occurredAt);
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
    harnessManager.recordAssistantMessage(
      scopeId,
      larkMessageId(sent.messageId)!,
      nowISO(),
    );
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
