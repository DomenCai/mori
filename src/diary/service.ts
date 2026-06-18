import type Database from "better-sqlite3";
import { genId, nowISO } from "../utils.js";
import type { EpisodeData } from "../agent/schemas.js";

export class DiaryService {
  constructor(private db: Database.Database) {}

  saveDiaryEntry(opts: {
    chatId: string;
    content: string;
    source?: string;
    inputType?: string;
    occurredAt?: string;
    conversationId?: string;
    metadata?: Record<string, any>;
  }): string {
    const id = genId("diary");
    const now = nowISO();
    this.db
      .prepare(
        `INSERT INTO diary_entries (id, chat_id, source, input_type, content, occurred_at, created_at, conversation_id, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.chatId,
        opts.source ?? "lark",
        opts.inputType ?? "text",
        opts.content,
        opts.occurredAt ?? now,
        now,
        opts.conversationId ?? null,
        JSON.stringify(opts.metadata ?? {}),
      );
    return id;
  }

  saveEpisode(diaryEntryId: string, data: EpisodeData): string {
    const id = genId("ep");
    const now = nowISO();
    const entry = this.db
      .prepare("SELECT occurred_at FROM diary_entries WHERE id = ?")
      .get(diaryEntryId) as { occurred_at: string } | undefined;

    this.db
      .prepare(
        `INSERT INTO episodes (id, diary_entry_id, brief, analysis_json, importance, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        diaryEntryId,
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
        entry?.occurred_at ?? now,
        now,
      );
    return id;
  }

  saveFallbackEpisode(diaryEntryId: string, content: string): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    const brief =
      normalized.length > 120
        ? `${normalized.slice(0, 117)}...`
        : normalized || "（空日记）";

    return this.saveEpisode(diaryEntryId, {
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

  hasEpisode(diaryEntryId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM episodes WHERE diary_entry_id = ?")
      .get(diaryEntryId);
    return !!row;
  }

  getRecentEntries(limit = 7): Array<{ id: string; content: string; occurred_at: string }> {
    return this.db
      .prepare(
        "SELECT id, content, occurred_at FROM diary_entries ORDER BY occurred_at DESC LIMIT ?",
      )
      .all(limit) as any;
  }

  getLastEntryTime(): string | null {
    const row = this.db
      .prepare(
        "SELECT occurred_at FROM diary_entries ORDER BY occurred_at DESC LIMIT 1",
      )
      .get() as { occurred_at: string } | undefined;
    return row?.occurred_at ?? null;
  }

  getEpisodesSince(since: string): Array<Record<string, any>> {
    return this.db
      .prepare(
        `SELECT e.*, d.content as diary_content
         FROM episodes e
         JOIN diary_entries d ON d.id = e.diary_entry_id
         WHERE e.occurred_at >= ?
         ORDER BY e.occurred_at ASC`,
      )
      .all(since) as any;
  }
}
