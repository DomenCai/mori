import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { agentDir, knowledgeIndexPath } from "../config.js";

function readPromptFile(name: string): string {
  return readFileSync(join(agentDir, name), "utf-8");
}

const soul = readPromptFile("soul.md");
const memoryPolicy = readPromptFile("memory_policy.md");
const responseStyle = readPromptFile("response_style.md");

export interface MemorySnapshot {
  profile: string;
  activeStorylines: Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    summary: string;
    current_tension: string | null;
    emotional_arc: string | null;
    people: string[];
    last_active_at: string;
  }>;
  recentDormantStorylines: Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    summary: string;
    current_tension: string | null;
    emotional_arc: string | null;
    people: string[];
    last_active_at: string;
  }>;
  freshEpisodes: Array<{
    id: string;
    brief: string | null;
    occurred_at: string;
    source_conversation_id: string;
    source_message_id: string | null;
  }>;
  knowledgeIndex: string;
}

export function buildMemorySnapshot(db: Database.Database): MemorySnapshot {
  const profile = db
    .prepare("SELECT content FROM profile WHERE id = 1")
    .get() as { content: string } | undefined;

  const activeStorylines = db
    .prepare(
      `SELECT id, kind, title, status, summary, current_tension, emotional_arc,
              people_json, last_active_at
       FROM storylines
       WHERE status = 'active'
       ORDER BY last_active_at DESC`,
    )
    .all() as Array<Record<string, any>>;

  const dormantStorylines = db
    .prepare(
      `SELECT id, kind, title, status, summary, current_tension, emotional_arc,
              people_json, last_active_at
       FROM storylines
       WHERE status = 'dormant'
       ORDER BY last_active_at DESC
       LIMIT 5`,
    )
    .all() as Array<Record<string, any>>;

  const episodes = db
    .prepare(
      `SELECT id, brief, occurred_at, source_conversation_id, source_message_id
       FROM episodes
       WHERE digested_run_id IS NULL
       ORDER BY occurred_at ASC
       LIMIT 10`,
    )
    .all();

  return {
    profile: profile?.content ?? "",
    activeStorylines: activeStorylines.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      summary: r.summary,
      current_tension: r.current_tension,
      emotional_arc: r.emotional_arc,
      people: JSON.parse(r.people_json),
      last_active_at: r.last_active_at,
    })),
    recentDormantStorylines: dormantStorylines.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      summary: r.summary,
      current_tension: r.current_tension,
      emotional_arc: r.emotional_arc,
      people: JSON.parse(r.people_json),
      last_active_at: r.last_active_at,
    })),
    freshEpisodes: (episodes as Array<Record<string, any>>).map((r) => ({
      id: r.id,
      brief: r.brief,
      occurred_at: r.occurred_at,
      source_conversation_id: r.source_conversation_id,
      source_message_id: r.source_message_id,
    })),
    knowledgeIndex: existsSync(knowledgeIndexPath)
      ? readFileSync(knowledgeIndexPath, "utf-8")
      : "（知识地图尚未生成）",
  };
}

export function buildSystemPrompt(snapshot: MemorySnapshot): string {
  const sections: string[] = [];

  sections.push(soul);
  sections.push(memoryPolicy);
  sections.push(responseStyle);

  sections.push("---\n# 身份画像\n" + snapshot.profile);

  if (snapshot.activeStorylines.length > 0) {
    const items = snapshot.activeStorylines
      .map((item) => {
        const lines = [`## ${item.id} | ${item.title}（${item.kind}）`];
        lines.push(`摘要：${item.summary}`);
        if (item.current_tension) lines.push(`当前张力：${item.current_tension}`);
        if (item.emotional_arc) lines.push(`情绪/态度弧线：${item.emotional_arc}`);
        if (item.people.length) lines.push(`相关人：${item.people.join("、")}`);
        lines.push(`last_active_at：${item.last_active_at}`);
        return lines.join("\n");
      })
      .join("\n\n");
    sections.push("---\n# Storylines（active）\n" + items);
  }

  if (snapshot.recentDormantStorylines.length > 0) {
    const items = snapshot.recentDormantStorylines
      .map((item) => {
        const lines = [`## ${item.id} | ${item.title}（${item.kind}, dormant）`];
        lines.push(`摘要：${item.summary}`);
        if (item.current_tension) lines.push(`当前张力：${item.current_tension}`);
        if (item.emotional_arc) lines.push(`情绪/态度弧线：${item.emotional_arc}`);
        lines.push(`last_active_at：${item.last_active_at}`);
        return lines.join("\n");
      })
      .join("\n\n");
    sections.push("---\n# Storylines（recent dormant）\n" + items);
  }

  if (snapshot.freshEpisodes.length > 0) {
    const eps = snapshot.freshEpisodes
      .map((e) => `- ${e.id} [${e.occurred_at}] ${e.brief ?? "（无摘要）"}`)
      .join("\n");
    sections.push("---\n# Fresh episodes（尚未被 daily_memory 消化）\n" + eps);
  }

  sections.push("---\n# 知识地图\n" + snapshot.knowledgeIndex);

  return sections.join("\n\n");
}
