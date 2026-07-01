import type { NormalizedMessage } from "@larksuite/channel";
import type { ConversationType, IngestedMessage } from "../ingest/message.js";
import { nowISO } from "../utils.js";

export function larkMessageId(id: string | null | undefined): string | null {
  return id ? `lark:${id}` : null;
}

export function larkChatConversationId(chatId: string): string {
  return `lark:chat:${chatId}`;
}

export function larkThreadKey(
  msg: Pick<NormalizedMessage, "chatMode" | "threadId" | "rootId" | "messageId">,
): string | null {
  if (msg.threadId) return msg.threadId;
  // 普通群回复也可能带 rootId；只有原生 topic chat 才把 rootId 当 thread key。
  if (msg.chatMode === "topic" && msg.rootId && msg.rootId !== msg.messageId) {
    return msg.rootId;
  }
  return null;
}

export function larkConversationId(
  msg: Pick<NormalizedMessage, "chatId" | "chatMode" | "threadId" | "rootId" | "messageId">,
): string {
  const threadKey = larkThreadKey(msg);
  return threadKey
    ? `lark:thread:${msg.chatId}:${threadKey}`
    : larkChatConversationId(msg.chatId);
}

export function toIngestedMessage(
  msg: NormalizedMessage,
  conversationType: ConversationType,
): IngestedMessage {
  return {
    id: larkMessageId(msg.messageId)!,
    source: "lark",
    conversationId: larkConversationId(msg),
    conversationType,
    role: "user",
    content: msg.content,
    occurredAt: msg.createTime ? new Date(msg.createTime).toISOString() : nowISO(),
    replyTo: larkMessageId(msg.replyToMessageId),
    threadId: msg.threadId ?? null,
    rootId: larkMessageId(msg.rootId),
  };
}
