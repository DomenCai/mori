import type { AgentTool } from "@earendil-works/pi-agent-core";
import type Database from "better-sqlite3";
import { SearchMemoryParams } from "../schemas.js";
import { searchMemory } from "../../retrieval/fts.js";

export function createSearchMemoryTool(
  db: Database.Database,
): AgentTool<typeof SearchMemoryParams> {
  return {
    name: "search_memory",
    label: "搜索记忆",
    description:
      "搜索 episode 蒸馏层，并按来源回查相关原文证据。≥3 字走 FTS，1-2 字走 LIKE 兜底。",
    parameters: SearchMemoryParams,
    execute: async (_id, params) => {
      const results = searchMemory(db, params.query, params.limit ?? 10);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `未找到与"${params.query}"相关的内容` }],
          details: { count: 0 },
        };
      }
      const text = results
        .map(
          (r) =>
            `[${r.type}] ${r.occurred_at} | ${r.snippet}${r.evidence ? `\n证据：${r.evidence.slice(0, 240)}` : ""}`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { count: results.length },
      };
    },
  };
}
