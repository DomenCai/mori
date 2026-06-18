import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { agentDir } from "../config.js";

function readPromptFile(name: string): string {
  return readFileSync(join(agentDir, name), "utf-8");
}

const soul = readPromptFile("soul.md");
const memoryPolicy = readPromptFile("memory_policy.md");
const responseStyle = readPromptFile("response_style.md");

export interface MemorySnapshot {
  profile: string;
  activeWorkingItems: Array<{
    id: string;
    type: string;
    name: string;
    status: string;
    thesis: string | null;
    current_questions: string[];
    decisions: string[];
    next_steps: string[];
    related_people: string[];
  }>;
  recentEpisodes: Array<{
    brief: string | null;
    occurred_at: string;
    diary_entry_id: string;
  }>;
}

export function buildMemorySnapshot(db: Database.Database): MemorySnapshot {
  const profile = db
    .prepare("SELECT content FROM profile WHERE id = 1")
    .get() as { content: string } | undefined;

  const items = db
    .prepare(
      `SELECT id, type, name, status, thesis,
              current_questions_json, decisions_json,
              next_steps_json, related_people_json
       FROM working_items WHERE status = 'active'
       ORDER BY updated_at DESC`,
    )
    .all() as Array<Record<string, any>>;

  const episodes = db
    .prepare(
      `SELECT brief, occurred_at, diary_entry_id
       FROM episodes ORDER BY occurred_at DESC LIMIT 10`,
    )
    .all() as Array<Record<string, any>>;

  return {
    profile: profile?.content ?? "",
    activeWorkingItems: items.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      status: r.status,
      thesis: r.thesis,
      current_questions: JSON.parse(r.current_questions_json),
      decisions: JSON.parse(r.decisions_json),
      next_steps: JSON.parse(r.next_steps_json),
      related_people: JSON.parse(r.related_people_json),
    })),
    recentEpisodes: episodes.map((r) => ({
      brief: r.brief,
      occurred_at: r.occurred_at,
      diary_entry_id: r.diary_entry_id,
    })),
  };
}

export function buildSystemPrompt(snapshot: MemorySnapshot): string {
  const sections: string[] = [];

  sections.push(soul);
  sections.push(memoryPolicy);
  sections.push(responseStyle);

  sections.push("---\n# 身份画像\n" + snapshot.profile);

  if (snapshot.activeWorkingItems.length > 0) {
    const items = snapshot.activeWorkingItems
      .map((item) => {
        const lines = [`## ${item.name}（${item.type}）`];
        if (item.thesis) lines.push(`主旨：${item.thesis}`);
        if (item.current_questions.length)
          lines.push(`当前问题：${item.current_questions.join("；")}`);
        if (item.decisions.length)
          lines.push(`已决策：${item.decisions.join("；")}`);
        if (item.next_steps.length)
          lines.push(`下一步：${item.next_steps.join("；")}`);
        if (item.related_people.length)
          lines.push(`相关人：${item.related_people.join("、")}`);
        return lines.join("\n");
      })
      .join("\n\n");
    sections.push("---\n# 工作集（active）\n" + items);
  }

  if (snapshot.recentEpisodes.length > 0) {
    const eps = snapshot.recentEpisodes
      .map((e) => `- [${e.occurred_at}] ${e.brief ?? "（无摘要）"}`)
      .join("\n");
    sections.push("---\n# 最近日记 episode\n" + eps);
  }

  return sections.join("\n\n");
}
