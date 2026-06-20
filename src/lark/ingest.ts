import type { NormalizedMessage } from "@larksuite/channel";
import type { ConversationType, IngestedMessage } from "../ingest/message.js";
import { nowISO } from "../utils.js";

export function larkMessageId(id: string | null | undefined): string | null {
  return id ? `lark:${id}` : null;
}

export function larkChatConversationId(chatId: string): string {
  return `lark:chat:${chatId}`;
}

export function larkConversationId(msg: Pick<NormalizedMessage, "chatId" | "threadId">): string {
  return msg.threadId
    ? `lark:thread:${msg.chatId}:${msg.threadId}`
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
