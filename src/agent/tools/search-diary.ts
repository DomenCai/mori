import type { AgentTool } from "@earendil-works/pi-agent-core";
import type Database from "better-sqlite3";
import { SearchDiaryParams } from "../schemas.js";
import { searchDiary } from "../../retrieval/fts.js";

export function createSearchDiaryTool(
  db: Database.Database,
): AgentTool<typeof SearchDiaryParams> {
  return {
    name: "search_diary",
    label: "搜索日记",
    description:
      "对日记原文和 episode 进行全文检索。≥3 字走 FTS，1-2 字走 LIKE 兜底。",
    parameters: SearchDiaryParams,
    execute: async (_id, params) => {
      const results = searchDiary(db, params.query, params.limit ?? 10);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `未找到与"${params.query}"相关的内容` }],
          details: { count: 0 },
        };
      }
      const text = results
        .map(
          (r) =>
            `[${r.type}] ${r.occurred_at} | ${r.snippet}`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { count: results.length },
      };
    },
  };
}
