import type Database from "better-sqlite3";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { ConversationType, IngestedMessage, MessageSource } from "../ingest/message.js";

export interface StoredMessage {
  id: string;
  source: MessageSource;
  conversation_id: string;
  conversation_type: ConversationType;
  role: "user" | "assistant";
  content: string;
  reply_to: string | null;
  thread_id: string | null;
  root_id: string | null;
  knowledge_path: string | null;
  occurred_at: string;
  created_at: string;
}

export class MessageService {
  constructor(private db: Database.Database, private clock: Clock = systemClock) {}

  saveUserMessage(msg: IngestedMessage): void {
    this.save({
      id: msg.id,
      source: msg.source,
      conversationId: msg.conversationId,
      conversationType: msg.conversationType,
      role: "user",
      content: msg.content,
      replyTo: msg.replyTo ?? null,
      threadId: msg.threadId ?? null,
      rootId: msg.rootId ?? null,
      knowledgePath: msg.knowledgePath ?? null,
      occurredAt: msg.occurredAt,
      createdAt: this.clock.nowISO(),
    });
  }

  saveAssistantMessage(opts: {
    id: string;
    source: MessageSource;
    conversationId: string;
    conversationType: ConversationType;
    content: string;
    replyTo?: string | null;
    threadId?: string | null;
    rootId?: string | null;
    knowledgePath?: string | null;
    occurredAt?: string;
    createdAt?: string;
  }): void {
    this.save({
      id: opts.id,
      source: opts.source,
      conversationId: opts.conversationId,
      conversationType: opts.conversationType,
      role: "assistant",
      content: opts.content,
      replyTo: opts.replyTo ?? null,
      threadId: opts.threadId ?? null,
      rootId: opts.rootId ?? null,
      knowledgePath: opts.knowledgePath ?? null,
      occurredAt: opts.occurredAt ?? this.clock.nowISO(),
      createdAt: opts.createdAt ?? this.clock.nowISO(),
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

  getConversationMessages(
    conversationId: string,
    startedAt: string,
    endedAt: string,
  ): StoredMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND occurred_at BETWEEN ? AND ?
         ORDER BY occurred_at ASC`,
      )
      .all(conversationId, startedAt, endedAt) as StoredMessage[];
  }

  getLastUserMessageTime(conversationIds: string[]): string | null {
    if (conversationIds.length === 0) return null;
    const placeholders = conversationIds.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT occurred_at FROM messages
         WHERE role = 'user' AND source != 'import' AND conversation_id IN (${placeholders})
         ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get(...conversationIds) as { occurred_at: string } | undefined;
    return row?.occurred_at ?? null;
  }

  private save(opts: {
    id: string;
    source: MessageSource;
    conversationId: string;
    conversationType: ConversationType;
    role: "user" | "assistant";
    content: string;
    replyTo?: string | null;
    threadId?: string | null;
    rootId?: string | null;
    knowledgePath?: string | null;
    occurredAt: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, source, conversation_id, conversation_type, role, content, reply_to, thread_id, root_id, knowledge_path, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source = excluded.source,
           conversation_id = excluded.conversation_id,
           conversation_type = excluded.conversation_type,
           role = excluded.role,
           content = excluded.content,
           reply_to = excluded.reply_to,
           thread_id = excluded.thread_id,
           root_id = excluded.root_id,
           knowledge_path = coalesce(excluded.knowledge_path, messages.knowledge_path),
           occurred_at = excluded.occurred_at,
           created_at = excluded.created_at`,
      )
      .run(
        opts.id,
        opts.source,
        opts.conversationId,
        opts.conversationType,
        opts.role,
        opts.content,
        opts.replyTo ?? null,
        opts.threadId ?? null,
        opts.rootId ?? null,
        opts.knowledgePath ?? null,
        opts.occurredAt,
        opts.createdAt,
      );
  }
}
