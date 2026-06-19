// 飞书消息 → harness 驱动 → 流式卡片回复。日记群、普通会话、话题和通知反应分流处理。
import type {
  LarkChannel,
  NormalizedMessage,
  SendOptions,
} from "@larksuite/channel";
import { HarnessManager, type HarnessEntry } from "../agent/harness.js";
import type { DiaryService, EpisodeSource } from "../diary/service.js";
import { scopeIdForMessage } from "../storage/messages.js";
import { createAgentCardState, renderAgentCard, renderApprovalCard } from "./cards.js";
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

const DIARY_ENTRY_TOOL_NAMES = [
  "write_episode",
  "create_working_item",
  "update_working_item",
  "search_diary",
];
const DIARY_REPLY_TOOL_NAMES = [
  "search_diary",
  "create_working_item",
  "update_working_item",
];

export function isDiaryEntryMessage(msg: NormalizedMessage): boolean {
  return !msg.replyToMessageId && !msg.rootId;
}

export async function handleDiaryMessage(
  msg: NormalizedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  mode: "entry" | "reply",
): Promise<void> {
  const scopeId = msg.chatId;
  const entry = await harnessManager.getOrCreate(scopeId, "diary");
  const diaryService = harnessManager.getDiaryService();
  const messageService = harnessManager.getMessageService();
  const messageTime = messageCreatedAt(msg);
  harnessManager.recordActivity(scopeId, messageTime);

  await entry.harness.setActiveTools(
    mode === "entry" ? DIARY_ENTRY_TOOL_NAMES : DIARY_REPLY_TOOL_NAMES,
  );

  const episodeSource: EpisodeSource | null = mode === "entry"
    ? {
      scopeId,
      messageId: msg.messageId,
      startedAt: messageTime,
      endedAt: messageTime,
    }
    : null;
  entry.currentEpisodeSource = episodeSource;

  diaryLog.info(
    episodeSource
      ? `处理日记 chat=${msg.chatId} messageId=${msg.messageId}`
      : `处理日记回复 chat=${msg.chatId} replyTo=${msg.replyToMessageId ?? "unknown"}`,
  );

  let assistantText = "";
  const sent = await channel.stream(
    msg.chatId,
    {
      card: {
        initial: renderAgentCard(createAgentCardState()),
        producer: async (ctrl) => {
          const cardState = createAgentCardState();
          let promptError: string | null = null;

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
              await maybeSendApprovalCard(
                event.result,
                channel,
                msg.chatId,
                harnessManager,
              );
              await updateAgentCard(ctrl, cardState, { yieldForPatch: true });
            }
            if (event.type === "turn_end") {
              promptError = getAssistantError(event.message);
              lastTotalTokens = extractTotalTokens(event.message);
            }
          });

          try {
            const started = Date.now();
            try {
              await entry.harness.prompt(
                await formatDiaryPrompt(msg, mode, harnessManager),
              );
            } catch (err) {
              promptError = formatError(err);
              diaryLog.error("prompt 失败:", err);
            }
            const elapsed = Date.now() - started;

            const contextWindow = entry.harness.getModel().contextWindow;
            const buildMetrics = () => ({
              totalTokens: lastTotalTokens,
              contextWindow,
              elapsedMs: elapsed,
            });

            if (promptError) {
              diaryLog.warn(`prompt 失败 耗时=${elapsed}ms: ${promptError}`);
              if (
                episodeSource &&
                !diaryService.hasEpisodeForMessage(msg.messageId)
              ) {
                diaryService.saveFallbackEpisode(episodeSource, msg.content);
              }
              cardState.terminal = "error";
              cardState.footer = null;
              cardState.status = episodeSource
                ? `> 处理失败，已保存原文和兜底 episode：${promptError}`
                : `> 处理失败：${promptError}`;
              cardState.metrics = buildMetrics();
              await ctrl.update(renderAgentCard(cardState));
              return;
            }
            diaryLog.info(`prompt 完成 耗时=${elapsed}ms`);

            const episodeResult = episodeSource
              ? await ensureDiaryEpisode(
                diaryService,
                entry,
                episodeSource,
                msg.content,
              )
              : {};
            cardState.terminal = "done";
            cardState.footer = null;
            cardState.status = episodeResult.fallbackReason
              ? `> ${episodeResult.fallbackReason}`
              : undefined;
            cardState.metrics = buildMetrics();
            await ctrl.update(renderAgentCard(cardState));
          } finally {
            unsubscribe();
            entry.currentEpisodeSource = null;
          }
        },
      },
    },
    replyOptions(msg),
  );

  messageService.saveAssistantMessage({
    id: sent.messageId,
    chatId: msg.chatId,
    content: assistantText || "（卡片回复）",
    replyTo: msg.messageId,
    threadId: msg.threadId ?? null,
    rootId: msg.rootId ?? null,
  });
}

export async function handleChatMessage(
  msg: NormalizedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: "dm" | "topic" | "thread",
): Promise<void> {
  const scopeId = scopeIdForMessage(msg);
  const entry = await harnessManager.getOrCreate(scopeId, chatType);
  const messageService = harnessManager.getMessageService();
  const messageTime = messageCreatedAt(msg);
  harnessManager.recordActivity(scopeId, messageTime);
  await promoteKnowledgeIfNeeded(msg, harnessManager);
  larkLog.info(`处理对话 scope=${scopeId} type=${chatType}`);
  const started = Date.now();

  let assistantText = "";
  const sent = await channel.stream(
    msg.chatId,
    {
      card: {
        initial: renderAgentCard(createAgentCardState()),
        producer: async (ctrl) => {
          const cardState = createAgentCardState();
          let promptError: string | null = null;

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
              await maybeSendApprovalCard(
                event.result,
                channel,
                msg.chatId,
                harnessManager,
              );
              await updateAgentCard(ctrl, cardState, { yieldForPatch: true });
            }
            if (event.type === "turn_end") {
              promptError = getAssistantError(event.message);
              lastTotalTokens = extractTotalTokens(event.message);
            }
          });

          try {
            try {
              await entry.harness.prompt(
                await formatChatPrompt(msg, harnessManager),
              );
            } catch (err) {
              promptError = formatError(err);
              larkLog.error("prompt 失败:", err);
            }
            const elapsed = Date.now() - started;
            const contextWindow = entry.harness.getModel().contextWindow;
            const metrics = {
              totalTokens: lastTotalTokens,
              contextWindow,
              elapsedMs: elapsed,
            };

            if (promptError) {
              larkLog.warn(
                `回复失败 chat=${msg.chatId} 耗时=${elapsed}ms: ${promptError}`,
              );
              cardState.terminal = "error";
              cardState.footer = null;
              cardState.status = `> 处理失败：${promptError}`;
              cardState.metrics = metrics;
              await ctrl.update(renderAgentCard(cardState));
              return;
            }
            larkLog.info(`回复完成 chat=${msg.chatId} 耗时=${elapsed}ms`);
            cardState.terminal = "done";
            cardState.footer = null;
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

  messageService.saveAssistantMessage({
    id: sent.messageId,
    chatId: msg.chatId,
    content: assistantText || "（卡片回复）",
    replyTo: msg.messageId,
    threadId: msg.threadId ?? null,
    rootId: msg.rootId ?? null,
  });
}

export async function handleNotificationMessage(
  msg: NormalizedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
): Promise<boolean> {
  if (msg.threadId) {
    return false;
  }
  if (!msg.replyToMessageId) {
    await channel.send(msg.chatId, {
      text: "通知群只捕获对知识卡片的回复；要深聊请用话题回复。",
    });
    return true;
  }

  const parent = harnessManager.getMessageService().get(msg.replyToMessageId);
  if (!parent?.knowledge_path) return false;

  const nextPath = await promoteKnowledgeIfNeeded(msg, harnessManager);
  const source: EpisodeSource = {
    scopeId: msg.chatId,
    messageId: msg.messageId,
    startedAt: messageCreatedAt(msg),
    endedAt: messageCreatedAt(msg),
  };
  harnessManager.getDiaryService().saveFallbackEpisode(
    source,
    `用户对知识卡片 ${nextPath ?? parent.knowledge_path} 的反应：${msg.content}`,
  );

  const sent = await channel.send(msg.chatId, {
    text: "已收藏，并记下你的看法。",
  }, { replyTo: msg.messageId });
  harnessManager.getMessageService().saveAssistantMessage({
    id: sent.messageId,
    chatId: msg.chatId,
    content: "已收藏，并记下你的看法。",
    replyTo: msg.messageId,
  });
  return true;
}

async function ensureDiaryEpisode(
  diaryService: DiaryService,
  entry: HarnessEntry,
  source: EpisodeSource,
  content: string,
): Promise<{ fallbackReason?: string }> {
  if (source.messageId && diaryService.hasEpisodeForMessage(source.messageId)) {
    return {};
  }

  diaryLog.warn(`episode 缺失，触发补救 prompt: message_id=${source.messageId}`);
  entry.currentEpisodeSource = source;
  try {
    await entry.harness.prompt(`你刚才没有为这篇日记写 episode。请只调用 write_episode 工具完成蒸馏，不要输出面向用户的回复文本。

原日记：
${content}`);
  } catch (err) {
    diaryLog.error("episode 补救 prompt 失败，使用兜底 episode:", err);
    diaryService.saveFallbackEpisode(source, content);
    return { fallbackReason: "episode 补救失败，已保存最小兜底 episode" };
  }

  if (source.messageId && diaryService.hasEpisodeForMessage(source.messageId)) {
    return {};
  }

  diaryLog.warn(`followUp 后 episode 仍缺失，使用兜底: message_id=${source.messageId}`);
  diaryService.saveFallbackEpisode(source, content);
  return { fallbackReason: "模型未写 episode，已保存最小兜底 episode" };
}

async function formatDiaryPrompt(
  msg: NormalizedMessage,
  mode: "entry" | "reply",
  harnessManager: HarnessManager,
): Promise<string> {
  const replyContext = buildReplyContext(msg, harnessManager);
  if (mode === "entry") {
    return `${replyContext}[日记群新日记]
这是一条新的日记群根消息。请先调用 write_episode 工具，把原文蒸馏成 episode；必要时再调用其它工具；最后再简短回复用户。

原文：
${msg.content}`;
  }

  return `${replyContext}[日记群追问]
这是用户在同一篇日记上下文里继续回复 Agent 的消息。保持日记群的陪伴语气和上下文连续性，但不要为了形式调用 write_episode，也不要把它当成新的日记入库。

用户回复：
${msg.content}`;
}

async function formatChatPrompt(
  msg: NormalizedMessage,
  harnessManager: HarnessManager,
): Promise<string> {
  return `${buildReplyContext(msg, harnessManager)}${msg.content}`;
}

export function buildReplyContext(
  msg: NormalizedMessage,
  harnessManager: HarnessManager,
): string {
  const contextMessageId = msg.replyToMessageId ?? msg.rootId;
  if (!contextMessageId) return "";
  const parent = harnessManager.getMessageService().get(contextMessageId);
  if (!parent) return "";
  const relation = msg.replyToMessageId ? "reply_to" : "root";
  const knowledge = parent.knowledge_path
    ? `\n[这是对知识卡片的回应，对应知识文件：${parent.knowledge_path}]`
    : "";
  return `[${relation} 原文]${knowledge}
${parent.content}

--- 当前用户消息 ---
`;
}

async function promoteKnowledgeIfNeeded(
  msg: NormalizedMessage,
  harnessManager: HarnessManager,
): Promise<string | null> {
  if (!msg.replyToMessageId) return null;
  const messageService = harnessManager.getMessageService();
  const parent = messageService.get(msg.replyToMessageId);
  if (!parent?.knowledge_path) return null;

  const nextPath = harnessManager.getVaultService().promote(parent.knowledge_path, {
    my_note: msg.content,
    reacted_at: nowISO(),
  });
  messageService.updateKnowledgePath(parent.id, nextPath);
  return nextPath;
}

async function maybeSendApprovalCard(
  result: unknown,
  channel: LarkChannel,
  chatId: string,
  harnessManager: HarnessManager,
): Promise<void> {
  const approvalId = extractApprovalId(result);
  if (!approvalId) return;

  const approvalService = harnessManager.getApprovalService();
  const approval = approvalService.get(approvalId);
  if (!approval) return;
  const payload = approvalService.parsePayload(approval);
  const sent = await channel.send(chatId, {
    card: renderApprovalCard(approvalId, payload),
  });
  approvalService.attachMessage(approvalId, chatId, sent.messageId);
  harnessManager.getMessageService().saveAssistantMessage({
    id: sent.messageId,
    chatId,
    content: `工作集变更审批：${approvalId}`,
    replyTo: null,
  });
}

function extractApprovalId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const approvalId = (details as { approvalId?: unknown }).approvalId;
  return typeof approvalId === "string" ? approvalId : null;
}

function replyOptions(msg: NormalizedMessage): SendOptions {
  return {
    replyTo: msg.messageId,
    replyInThread: !!msg.threadId,
  };
}

function messageCreatedAt(msg: NormalizedMessage): string {
  return msg.createTime ? new Date(msg.createTime).toISOString() : nowISO();
}
