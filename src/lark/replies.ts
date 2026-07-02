import type {
  LarkChannel,
  NormalizedMessage,
  SendOptions,
} from "@larksuite/channel";
import type { BaseAgent } from "../agent/index.js";
import type { Logger } from "../log.js";
import { larkThreadKey } from "./ingest.js";
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

export interface StreamAgentReplyOutcome {
  promptError?: string | null;
  successStatus?: string;
  errorStatus?: string;
}

export interface AgentReplyResult {
  assistantText: string;
  messageIds: string[];
  texts: string[];
}

export type AgentReplyMode = "agent-card-stream" | "markdown-stream" | "markdown";
export type InteractiveChatType = "dm" | "topic" | "thread";

export interface ReplyBehavior {
  showReplyTo?: boolean;
  replyInThread?: boolean;
}

function replyModeForThread(msg: NormalizedMessage): AgentReplyMode {
  return msg.chatMode === "topic" ? "markdown" : "markdown-stream";
}

export function replyModeForChat(
  chatType: InteractiveChatType,
  msg: NormalizedMessage,
  isThreadReply: boolean,
): AgentReplyMode {
  if (chatType === "dm") return "markdown-stream";
  return isThreadReply ? replyModeForThread(msg) : "agent-card-stream";
}

function defaultReplyInThread(msg: NormalizedMessage): boolean {
  // replyInThread 改变飞书落点；引用上下文和 session 恢复不要复用这个开关。
  return msg.chatMode === "topic" ? false : !!larkThreadKey(msg);
}

function replyOptions(msg: NormalizedMessage, behavior: ReplyBehavior = {}): SendOptions {
  return {
    replyTo: behavior.showReplyTo === false ? undefined : msg.messageId,
    replyInThread: behavior.replyInThread ?? defaultReplyInThread(msg),
  };
}

export function sendTextReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  text: string,
) {
  return channel.send(msg.chatId, { text }, replyOptions(msg));
}

export function sendCardReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  card: object,
) {
  return channel.send(msg.chatId, { card }, replyOptions(msg));
}

export async function sendAgentReply(
  mode: AgentReplyMode,
  channel: LarkChannel,
  msg: NormalizedMessage,
  agent: BaseAgent,
  runPrompt: () => Promise<StreamAgentReplyOutcome | void>,
  log: Logger,
  behavior?: ReplyBehavior,
): Promise<AgentReplyResult> {
  switch (mode) {
    case "agent-card-stream":
      return sendCardStreamReply(channel, msg, agent, runPrompt, log, behavior);
    case "markdown-stream":
      return sendMarkdownStreamReply(channel, msg, agent, runPrompt, log, behavior);
    case "markdown":
      return sendMarkdownReply(channel, msg, agent, runPrompt, log, behavior);
  }
}

async function sendCardStreamReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  agent: BaseAgent,
  runPrompt: () => Promise<StreamAgentReplyOutcome | void>,
  log: Logger,
  behavior?: ReplyBehavior,
): Promise<AgentReplyResult> {
  let assistantText = "";
  const started = Date.now();
  const opts = replyOptions(msg, behavior);
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

          const unsubscribe = agent.subscribe(async (event) => {
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
              contextWindow: agent.getModel().contextWindow,
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
    opts,
  );

  return {
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

// 流式 markdown 回复：底层是 CardKit streaming card。
async function sendMarkdownStreamReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  agent: BaseAgent,
  runPrompt: () => Promise<StreamAgentReplyOutcome | void>,
  log: Logger,
  behavior?: ReplyBehavior,
): Promise<AgentReplyResult> {
  let assistantText = "";
  let currentMessageText = "";
  let promptError: string | null = null;
  const started = Date.now();
  const opts = replyOptions(msg, behavior);

  const sent = await channel.stream(
    msg.chatId,
    {
      markdown: async (ctrl) => {
        const unsubscribe = agent.subscribe(async (event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            const delta = event.assistantMessageEvent.delta;
            if (!delta) return;
            if (!currentMessageText && assistantText) {
              assistantText += "\n\n";
              await ctrl.append("\n\n");
            }
            currentMessageText += delta;
            assistantText += delta;
            await ctrl.append(delta);
          }
          if (event.type === "message_end") {
            const text = assistantMessageText(event.message);
            if (text && !currentMessageText) {
              if (assistantText) {
                assistantText += "\n\n";
                await ctrl.append("\n\n");
              }
              assistantText += text;
              await ctrl.append(text);
            }
            currentMessageText = "";
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

        if (promptError) {
          const text = assistantText.trim()
            ? `\n\n> 处理失败：${promptError}`
            : `处理失败：${promptError}`;
          assistantText += text;
          await ctrl.append(text);
        } else if (!assistantText.trim()) {
          assistantText = "…";
          await ctrl.append(assistantText);
        }

        const elapsed = Date.now() - started;
        log[promptError ? "warn" : "info"](
          `回复${promptError ? "失败" : "完成"} chat=${msg.chatId} 耗时=${elapsed}ms`,
        );
      },
    },
    opts,
  );

  return {
    assistantText,
    messageIds: [sent.messageId],
    texts: [assistantText],
  };
}

// 普通 markdown 回复：发送为 Feishu post/富文本消息，话题外层能显示正文摘要。
async function sendMarkdownReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  agent: BaseAgent,
  runPrompt: () => Promise<StreamAgentReplyOutcome | void>,
  log: Logger,
  behavior?: ReplyBehavior,
): Promise<AgentReplyResult> {
  const texts: string[] = [];
  const messageIds: string[] = [];
  let lastMessageId = "";
  let promptError: string | null = null;
  const started = Date.now();
  const opts = replyOptions(msg, behavior);

  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === "message_end") {
      const text = assistantMessageText(event.message);
      if (!text) return;
      texts.push(text);
      const sent = await channel.send(msg.chatId, { markdown: text }, opts);
      lastMessageId = sent.messageId;
      messageIds.push(sent.messageId);
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
    const text = texts.length ? `> 处理失败：${promptError}` : `处理失败：${promptError}`;
    const sent = await channel.send(msg.chatId, { markdown: text }, opts);
    lastMessageId = sent.messageId;
    messageIds.push(sent.messageId);
    texts.push(text);
  } else if (!texts.length) {
    const text = "…";
    const sent = await channel.send(msg.chatId, { markdown: text }, opts);
    lastMessageId = sent.messageId;
    messageIds.push(sent.messageId);
    texts.push(text);
  }

  return {
    assistantText: texts.join("\n\n"),
    messageIds,
    texts,
  };
}
