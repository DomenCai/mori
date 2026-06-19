import type Database from "better-sqlite3";
import { genId, nowISO } from "../utils.js";
import type { EpisodeData } from "../agent/schemas.js";
import { splitScopeId } from "../storage/messages.js";

export interface EpisodeSource {
  scopeId: string;
  messageId: string | null;
  startedAt: string;
  endedAt: string;
}

export class DiaryService {
  constructor(private db: Database.Database) {}

  saveEpisode(source: EpisodeSource, data: EpisodeData): string {
    const id = genId("ep");
    const now = nowISO();
    this.db
      .prepare(
        `INSERT INTO episodes (id, source_scope_id, source_message_id, source_started_at, source_ended_at, brief, analysis_json, importance, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        source.scopeId,
        source.messageId,
        source.startedAt,
        source.endedAt,
        data.brief,
        JSON.stringify({
          facts: data.facts,
          emotions: data.emotions,
          thoughts: data.thoughts,
          blind_spots: data.blind_spots,
          actions: data.actions,
          long_term_memory_candidates: data.long_term_memory_candidates,
        }),
        5,
        source.endedAt,
        now,
      );
    return id;
  }

  saveFallbackEpisode(source: EpisodeSource, content: string): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    const brief =
      normalized.length > 120
        ? `${normalized.slice(0, 117)}...`
        : normalized || "（空内容）";

    return this.saveEpisode(source, {
      brief,
      facts: [
        {
          text: "原文记录",
          evidence: content,
        },
      ],
      emotions: [],
      thoughts: [],
      blind_spots: [],
      actions: [],
      long_term_memory_candidates: [],
    });
  }

  hasEpisodeForMessage(messageId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM episodes WHERE source_message_id = ?")
      .get(messageId);
    return !!row;
  }

  hasEpisodeForScopeWindow(source: EpisodeSource): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM episodes
         WHERE source_scope_id = ? AND source_message_id IS NULL
           AND source_started_at = ? AND source_ended_at = ?`,
      )
      .get(source.scopeId, source.startedAt, source.endedAt);
    return !!row;
  }

  getEpisodesSince(since: string): Array<Record<string, any>> {
    return this.db
      .prepare(
        `SELECT e.*,
                m.content AS source_message_content
         FROM episodes e
         LEFT JOIN messages m ON m.id = e.source_message_id
         WHERE e.occurred_at >= ?
         ORDER BY e.occurred_at ASC`,
      )
      .all(since) as Array<Record<string, any>>;
  }

  getSourceMessagesForEpisode(episode: {
    source_scope_id: string;
    source_message_id: string | null;
    source_started_at: string;
    source_ended_at: string;
  }): Array<{ role: string; content: string; created_at: string }> {
    if (episode.source_message_id) {
      return this.db
        .prepare(
          `SELECT role, content, created_at FROM messages
           WHERE id = ?
           ORDER BY created_at ASC`,
        )
        .all(episode.source_message_id) as Array<{
        role: string;
        content: string;
        created_at: string;
      }>;
    }

    const { chatId, threadId } = splitScopeId(episode.source_scope_id);
    if (threadId) {
      return this.db
        .prepare(
          `SELECT role, content, created_at FROM messages
           WHERE chat_id = ? AND thread_id = ? AND created_at BETWEEN ? AND ?
           ORDER BY created_at ASC`,
        )
        .all(
          chatId,
          threadId,
          episode.source_started_at,
          episode.source_ended_at,
        ) as Array<{ role: string; content: string; created_at: string }>;
    }

    return this.db
      .prepare(
        `SELECT role, content, created_at FROM messages
         WHERE chat_id = ? AND thread_id IS NULL AND created_at BETWEEN ? AND ?
         ORDER BY created_at ASC`,
      )
      .all(
        chatId,
        episode.source_started_at,
        episode.source_ended_at,
      ) as Array<{ role: string; content: string; created_at: string }>;
  }
}
