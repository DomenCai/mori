// 飞书消息 → harness 驱动 → 流式卡片回复。日记群与普通会话两条路径。
import type { NormalizedMessage, LarkChannel } from "@larksuite/channel";
import { HarnessManager, type HarnessEntry } from "../agent/harness.js";
import type { DiaryService } from "../diary/service.js";
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

const larkLog = logger("lark");
const diaryLog = logger("diary");

const DIARY_ENTRY_TOOL_NAMES = [
  "write_episode",
  "upsert_working_item",
  "search_diary",
];
const DIARY_REPLY_TOOL_NAMES = ["search_diary", "upsert_working_item"];

export function isDiaryEntryMessage(msg: NormalizedMessage): boolean {
  return !msg.replyToMessageId && !msg.rootId;
}

export async function handleDiaryMessage(
  msg: NormalizedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  mode: "entry" | "reply",
): Promise<void> {
  const entry = await harnessManager.getOrCreate(msg.chatId, "diary");
  const diaryService = harnessManager.getDiaryService();
  await entry.harness.setActiveTools(
    mode === "entry" ? DIARY_ENTRY_TOOL_NAMES : DIARY_REPLY_TOOL_NAMES,
  );

  const diaryEntryId =
    mode === "entry"
      ? diaryService.saveDiaryEntry({
          chatId: msg.chatId,
          content: msg.content,
          source: "lark",
          inputType: "text",
        })
      : null;
  entry.currentDiaryEntryId = diaryEntryId;
  diaryLog.info(
    diaryEntryId
      ? `处理日记 chat=${msg.chatId} entryId=${diaryEntryId}`
      : `处理日记回复 chat=${msg.chatId} replyTo=${msg.replyToMessageId ?? "unknown"}`,
  );

  // 2. 流式回复
  await channel.stream(
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
            const started = Date.now();
            try {
              await entry.harness.prompt(formatDiaryPrompt(msg.content, mode));
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
              if (diaryEntryId && !diaryService.hasEpisode(diaryEntryId)) {
                diaryService.saveFallbackEpisode(diaryEntryId, msg.content);
              }
              cardState.terminal = "error";
              cardState.footer = null;
              cardState.status = diaryEntryId
                ? `> 处理失败，已保存原文和兜底 episode：${promptError}`
                : `> 处理失败：${promptError}`;
              cardState.metrics = buildMetrics();
              await ctrl.update(renderAgentCard(cardState));
              return;
            }
            diaryLog.info(`prompt 完成 耗时=${elapsed}ms`);

            const episodeResult = diaryEntryId
              ? await ensureDiaryEpisode(
                  diaryService,
                  entry,
                  diaryEntryId,
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
          }
        },
      },
    },
    { replyTo: msg.messageId },
  );
}

export async function handleChatMessage(
  msg: NormalizedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: string,
): Promise<void> {
  const type = chatType === "diary" ? "diary" : "dm";
  const entry = await harnessManager.getOrCreate(msg.chatId, type);
  larkLog.info(`处理对话 chat=${msg.chatId} type=${type}`);
  const started = Date.now();

  await channel.stream(
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
              await entry.harness.prompt(msg.content);
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
    { replyTo: msg.messageId },
  );
}

async function ensureDiaryEpisode(
  diaryService: DiaryService,
  entry: HarnessEntry,
  diaryEntryId: string,
  content: string,
): Promise<{ fallbackReason?: string }> {
  if (diaryService.hasEpisode(diaryEntryId)) return {};

  diaryLog.warn(`episode 缺失，触发补救 prompt: diary_entry_id=${diaryEntryId}`);
  try {
    await entry.harness.prompt(`你刚才没有为这篇日记写 episode。请只调用 write_episode 工具完成蒸馏，不要输出面向用户的回复文本。

原日记：
${content}`);
  } catch (err) {
    diaryLog.error("episode 补救 prompt 失败，使用兜底 episode:", err);
    diaryService.saveFallbackEpisode(diaryEntryId, content);
    return { fallbackReason: "episode 补救失败，已保存最小兜底 episode" };
  }

  if (diaryService.hasEpisode(diaryEntryId)) return {};

  diaryLog.warn(`followUp 后 episode 仍缺失，使用兜底: diary_entry_id=${diaryEntryId}`);
  diaryService.saveFallbackEpisode(diaryEntryId, content);
  return { fallbackReason: "模型未写 episode，已保存最小兜底 episode" };
}

function formatDiaryPrompt(content: string, mode: "entry" | "reply"): string {
  if (mode === "entry") {
    return `[日记群新日记]
这是一条新的日记群根消息。请先调用 write_episode 工具，把原文蒸馏成 episode；必要时再调用其它工具；最后再简短回复用户。

原文：
${content}`;
  }

  return `[日记群追问]
这是用户在同一篇日记上下文里继续回复 Agent 的消息。保持日记群的陪伴语气和上下文连续性，但不要为了形式调用 write_episode，也不要把它当成新的日记入库。

用户回复：
${content}`;
}
