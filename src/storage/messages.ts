import type Database from "better-sqlite3";
import type { NormalizedMessage } from "@larksuite/channel";
import { nowISO } from "../utils.js";

export interface StoredMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  reply_to: string | null;
  thread_id: string | null;
  root_id: string | null;
  knowledge_path: string | null;
  created_at: string;
}

export class MessageService {
  constructor(private db: Database.Database) {}

  saveUserMessage(msg: NormalizedMessage): void {
    this.save({
      id: msg.messageId,
      chatId: msg.chatId,
      role: "user",
      content: msg.content,
      replyTo: msg.replyToMessageId ?? null,
      threadId: msg.threadId ?? null,
      rootId: msg.rootId ?? null,
      createdAt: msg.createTime
        ? new Date(msg.createTime).toISOString()
        : nowISO(),
    });
  }

  saveAssistantMessage(opts: {
    id: string;
    chatId: string;
    content: string;
    replyTo?: string | null;
    threadId?: string | null;
    rootId?: string | null;
    knowledgePath?: string | null;
    createdAt?: string;
  }): void {
    this.save({
      id: opts.id,
      chatId: opts.chatId,
      role: "assistant",
      content: opts.content,
      replyTo: opts.replyTo ?? null,
      threadId: opts.threadId ?? null,
      rootId: opts.rootId ?? null,
      knowledgePath: opts.knowledgePath ?? null,
      createdAt: opts.createdAt ?? nowISO(),
    });
  }

  updateKnowledgePath(messageId: string, knowledgePath: string): void {
    this.db
      .prepare("UPDATE messages SET knowledge_path = ? WHERE id = ?")
      .run(knowledgePath, messageId);
  }

  get(messageId: string): StoredMessage | null {
    return (
      (this.db
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(messageId) as StoredMessage | undefined) ?? null
    );
  }

  getScopeMessages(
    scopeId: string,
    startedAt: string,
    endedAt: string,
  ): StoredMessage[] {
    const { chatId, threadId } = splitScopeId(scopeId);
    if (threadId) {
      return this.db
        .prepare(
          `SELECT * FROM messages
           WHERE chat_id = ? AND thread_id = ? AND created_at BETWEEN ? AND ?
           ORDER BY created_at ASC`,
        )
        .all(chatId, threadId, startedAt, endedAt) as StoredMessage[];
    }

    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND thread_id IS NULL AND created_at BETWEEN ? AND ?
         ORDER BY created_at ASC`,
      )
      .all(chatId, startedAt, endedAt) as StoredMessage[];
  }

  getLastUserMessageTime(chatIds: string[]): string | null {
    if (chatIds.length === 0) return null;
    const placeholders = chatIds.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT created_at FROM messages
         WHERE role = 'user' AND chat_id IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(...chatIds) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  private save(opts: {
    id: string;
    chatId: string;
    role: "user" | "assistant";
    content: string;
    replyTo?: string | null;
    threadId?: string | null;
    rootId?: string | null;
    knowledgePath?: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, role, content, reply_to, thread_id, root_id, knowledge_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chat_id = excluded.chat_id,
           role = excluded.role,
           content = excluded.content,
           reply_to = excluded.reply_to,
           thread_id = excluded.thread_id,
           root_id = excluded.root_id,
           knowledge_path = coalesce(excluded.knowledge_path, messages.knowledge_path),
           created_at = excluded.created_at`,
      )
      .run(
        opts.id,
        opts.chatId,
        opts.role,
        opts.content,
        opts.replyTo ?? null,
        opts.threadId ?? null,
        opts.rootId ?? null,
        opts.knowledgePath ?? null,
        opts.createdAt,
      );
  }
}

export function scopeIdForMessage(msg: NormalizedMessage): string {
  return msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId;
}

export function splitScopeId(scopeId: string): {
  chatId: string;
  threadId: string | null;
} {
  const delimiter = scopeId.indexOf(":");
  if (delimiter < 0) return { chatId: scopeId, threadId: null };
  return {
    chatId: scopeId.slice(0, delimiter),
    threadId: scopeId.slice(delimiter + 1),
  };
}
