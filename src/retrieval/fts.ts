import type Database from "better-sqlite3";

export interface SearchResult {
  type: "episode";
  id: string;
  source_scope_id: string;
  source_message_id: string | null;
  source_started_at: string;
  source_ended_at: string;
  snippet: string;
  occurred_at: string;
  evidence?: string;
}

/**
 * 中文检索策略：
 * - ≥3 字：走 episodes_fts trigram
 * - 1-2 字：走 episodes LIKE 兜底
 *
 * 日记原文不再单独建 FTS；命中 episode 后按来源模型回查 messages。
 */
export function searchDiary(
  db: Database.Database,
  query: string,
  limit = 10,
): SearchResult[] {
  const rows = query.length >= 3
    ? searchEpisodesFts(db, query, limit)
    : searchEpisodesLike(db, query, limit);

  return rows.map((row) => ({
    ...row,
    evidence: readEpisodeEvidence(db, row),
  }));
}

function searchEpisodesFts(
  db: Database.Database,
  query: string,
  limit: number,
): SearchResult[] {
  return db
    .prepare(
      `SELECT e.id, e.source_scope_id, e.source_message_id,
              e.source_started_at, e.source_ended_at,
              snippet(episodes_fts, 0, '>>>', '<<<', '...', 40) as snippet,
              e.occurred_at
       FROM episodes_fts f
       JOIN episodes e ON e.rowid = f.rowid
       WHERE episodes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as SearchResult[];
}

function searchEpisodesLike(
  db: Database.Database,
  query: string,
  limit: number,
): SearchResult[] {
  const pattern = `%${query}%`;
  return db
    .prepare(
      `SELECT id, source_scope_id, source_message_id,
              source_started_at, source_ended_at,
              substr(coalesce(brief,'') || ' ' || analysis_json, max(1, instr(coalesce(brief,'') || ' ' || analysis_json, ?) - 20), 80) as snippet,
              occurred_at
       FROM episodes
       WHERE brief LIKE ? OR analysis_json LIKE ?
       ORDER BY occurred_at DESC
       LIMIT ?`,
    )
    .all(query, pattern, pattern, limit) as SearchResult[];
}

function readEpisodeEvidence(
  db: Database.Database,
  row: SearchResult,
): string | undefined {
  if (row.source_message_id) {
    const message = db
      .prepare("SELECT content FROM messages WHERE id = ?")
      .get(row.source_message_id) as { content: string } | undefined;
    return message?.content;
  }

  const delimiter = row.source_scope_id.indexOf(":");
  const chatId = delimiter < 0
    ? row.source_scope_id
    : row.source_scope_id.slice(0, delimiter);
  const threadId = delimiter < 0 ? null : row.source_scope_id.slice(delimiter + 1);

  const messages = threadId
    ? db
      .prepare(
        `SELECT role, content FROM messages
         WHERE chat_id = ? AND thread_id = ? AND created_at BETWEEN ? AND ?
         ORDER BY created_at ASC`,
      )
      .all(chatId, threadId, row.source_started_at, row.source_ended_at)
    : db
      .prepare(
        `SELECT role, content FROM messages
         WHERE chat_id = ? AND thread_id IS NULL AND created_at BETWEEN ? AND ?
         ORDER BY created_at ASC`,
      )
      .all(chatId, row.source_started_at, row.source_ended_at);

  const text = (messages as Array<{ role: string; content: string }>)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return text || undefined;
}
