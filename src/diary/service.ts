import type Database from "better-sqlite3";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { genId } from "../utils.js";
import type { EpisodeData } from "../agent/schemas.js";

export interface EpisodeSource {
  conversationId: string;
  messageId: string | null;
  startedAt: string;
  endedAt: string;
}

export class DiaryService {
  constructor(private db: Database.Database, private clock: Clock = systemClock) {}

  saveEpisode(source: EpisodeSource, data: EpisodeData): string {
    const id = genId("ep");
    const now = this.clock.nowISO();
    this.db
      .prepare(
        `INSERT INTO episodes (id, source_conversation_id, source_message_id, source_started_at, source_ended_at, brief, analysis_json, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        source.conversationId,
        source.messageId,
        source.startedAt,
        source.endedAt,
        data.brief,
        JSON.stringify({ observations: data.observations }),
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
      observations: [{ text: "原文记录", evidence: content }],
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
         WHERE source_conversation_id = ? AND source_message_id IS NULL
           AND source_started_at = ? AND source_ended_at = ?`,
      )
      .get(source.conversationId, source.startedAt, source.endedAt);
    return !!row;
  }

  getEpisodesInWindow(since: string, until: string | null): Array<Record<string, any>> {
    const untilClause = until ? "AND e.occurred_at < ?" : "";
    const params = until ? [since, until] : [since];
    return this.db
      .prepare(
        `SELECT e.*,
                m.content AS source_message_content
         FROM episodes e
         LEFT JOIN messages m ON m.id = e.source_message_id
         WHERE e.occurred_at >= ? ${untilClause}
         ORDER BY e.occurred_at ASC`,
      )
      .all(...params) as Array<Record<string, any>>;
  }

  getSourceMessagesForEpisode(episode: {
    source_conversation_id: string;
    source_message_id: string | null;
    source_started_at: string;
    source_ended_at: string;
  }): Array<{ role: string; content: string; created_at: string }> {
    if (episode.source_message_id) {
      return this.db
        .prepare(
          `SELECT role, content, occurred_at AS created_at FROM messages
           WHERE id = ?
           ORDER BY occurred_at ASC`,
        )
        .all(episode.source_message_id) as Array<{
        role: string;
        content: string;
        created_at: string;
      }>;
    }

    return this.db
      .prepare(
        `SELECT role, content, occurred_at AS created_at FROM messages
         WHERE conversation_id = ? AND occurred_at BETWEEN ? AND ?
         ORDER BY occurred_at ASC`,
      )
      .all(
        episode.source_conversation_id,
        episode.source_started_at,
        episode.source_ended_at,
      ) as Array<{ role: string; content: string; created_at: string }>;
  }
}
