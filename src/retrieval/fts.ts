import type Database from "better-sqlite3";

export interface SearchResult {
  type: "diary" | "episode";
  id: string;
  diary_entry_id: string;
  snippet: string;
  occurred_at: string;
}

/**
 * 中文检索策略：
 * - ≥3 字：走 FTS trigram（快、可回表）
 * - 1-2 字：走 LIKE 兜底（个人数据量可接受）
 */
export function searchDiary(
  db: Database.Database,
  query: string,
  limit = 10,
): SearchResult[] {
  const results: SearchResult[] = [];
  const usesFts = query.length >= 3;

  if (usesFts) {
    const diaryRows = db
      .prepare(
        `SELECT d.id, d.id as diary_entry_id,
                snippet(diary_entries_fts, 0, '>>>', '<<<', '...', 40) as snippet,
                d.occurred_at
         FROM diary_entries_fts f
         JOIN diary_entries d ON d.rowid = f.rowid
         WHERE diary_entries_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as any[];
    results.push(
      ...diaryRows.map((r: any) => ({ type: "diary" as const, ...r })),
    );

    const epRows = db
      .prepare(
        `SELECT e.id, e.diary_entry_id,
                snippet(episodes_fts, 0, '>>>', '<<<', '...', 40) as snippet,
                e.occurred_at
         FROM episodes_fts f
         JOIN episodes e ON e.rowid = f.rowid
         WHERE episodes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as any[];
    results.push(
      ...epRows.map((r: any) => ({ type: "episode" as const, ...r })),
    );
  } else {
    const pattern = `%${query}%`;
    const diaryRows = db
      .prepare(
        `SELECT id, id as diary_entry_id,
                substr(content, max(1, instr(content, ?) - 20), 80) as snippet,
                occurred_at
         FROM diary_entries
         WHERE content LIKE ?
         ORDER BY occurred_at DESC
         LIMIT ?`,
      )
      .all(query, pattern, limit) as any[];
    results.push(
      ...diaryRows.map((r: any) => ({ type: "diary" as const, ...r })),
    );

    const epRows = db
      .prepare(
        `SELECT id, diary_entry_id,
                substr(coalesce(brief,'') || ' ' || analysis_json, max(1, instr(coalesce(brief,'') || ' ' || analysis_json, ?) - 20), 80) as snippet,
                occurred_at
         FROM episodes
         WHERE brief LIKE ? OR analysis_json LIKE ?
         ORDER BY occurred_at DESC
         LIMIT ?`,
      )
      .all(query, pattern, pattern, limit) as any[];
    results.push(
      ...epRows.map((r: any) => ({ type: "episode" as const, ...r })),
    );
  }

  return results.slice(0, limit);
}
