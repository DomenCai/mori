import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { agentDir, builtinAgentDir } from "../config.js";
import type { MemoryService } from "../memory/service.js";

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function readBuiltinPrompt(name: string): string {
  return readFileSync(join(builtinAgentDir, name), "utf-8").trim();
}

function readOverridablePrompt(name: "soul.md" | "response_style.md"): string {
  const override = stripHtmlComments(readFileSync(join(agentDir, name), "utf-8"));
  return override || readBuiltinPrompt(name);
}

function readPromptSet(): {
  soul: string;
  memoryPolicy: string;
  knowledgePolicy: string;
  responseStyle: string;
} {
  return {
    soul: readOverridablePrompt("soul.md"),
    memoryPolicy: readBuiltinPrompt("memory_policy.md"),
    knowledgePolicy: readBuiltinPrompt("knowledge_policy.md"),
    responseStyle: readOverridablePrompt("response_style.md"),
  };
}

const DORMANT_STORYLINE_LIMIT = 5;
const DORMANT_STORYLINE_LIMIT_WITH_CHAPTER = 2;

export interface MemorySnapshot {
  profile: string;
  chapter: string;
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
}

export function buildMemorySnapshot(
  db: Database.Database,
  memoryService: MemoryService,
): MemorySnapshot {
  const chapterText = memoryService.getChapter();

  const activeStorylines = db
    .prepare(
      `SELECT id, kind, title, status, summary, current_tension, emotional_arc,
              people_json, last_active_at
       FROM storylines
       WHERE status = 'active'
       ORDER BY last_active_at DESC, id ASC`,
    )
    .all() as Array<Record<string, any>>;

  const dormantStorylines = db
    .prepare(
      `SELECT id, kind, title, status, summary, current_tension, emotional_arc,
              people_json, last_active_at
       FROM storylines
       WHERE status = 'dormant'
       ORDER BY last_active_at DESC, id ASC
       LIMIT ?`,
    )
    .all(
      chapterText.trim()
        ? DORMANT_STORYLINE_LIMIT_WITH_CHAPTER
        : DORMANT_STORYLINE_LIMIT,
    ) as Array<Record<string, any>>;

  const episodes = db
    .prepare(
      `SELECT id, brief, occurred_at, source_conversation_id, source_message_id
       FROM episodes
       WHERE digested_run_id IS NULL
       ORDER BY occurred_at ASC, id ASC
       LIMIT 10`,
    )
    .all();

  return {
    profile: memoryService.getProfile(),
    chapter: chapterText,
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
  };
}

export function buildSystemPrompt(snapshot: MemorySnapshot): string {
  const sections: string[] = [];
  const hasChapter = snapshot.chapter.trim().length > 0;
  const promptSet = readPromptSet();

  sections.push(promptSet.soul);
  sections.push(promptSet.memoryPolicy);
  sections.push(promptSet.knowledgePolicy);
  sections.push(promptSet.responseStyle);

  sections.push("---\n# 身份画像\n" + snapshot.profile);

  if (hasChapter) {
    sections.push("---\n# 当前主线\n" + snapshot.chapter.trim());
  }

  if (snapshot.activeStorylines.length > 0) {
    const items = snapshot.activeStorylines
      .map((item) => {
        const lines = [`## ${item.id} | ${item.title}（${item.kind}）`];
        lines.push(`摘要：${item.summary}`);
        if (item.current_tension) lines.push(`当前张力：${item.current_tension}`);
        if (item.emotional_arc) lines.push(`情绪/态度弧线：${item.emotional_arc}`);
        if (item.people.length) lines.push(`相关人：${item.people.join("、")}`);
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
        if (!hasChapter) {
          if (item.current_tension) lines.push(`当前张力：${item.current_tension}`);
          if (item.emotional_arc) lines.push(`情绪/态度弧线：${item.emotional_arc}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
    sections.push("---\n# Storylines（recent dormant）\n" + items);
  }

  if (snapshot.freshEpisodes.length > 0) {
    const eps = snapshot.freshEpisodes
      .map((e) => `- ${e.id} ${e.brief ?? "（无摘要）"}`)
      .join("\n");
    sections.push("---\n# Fresh episodes（尚未被 daily_memory 消化）\n" + eps);
  }

  return sections.join("\n\n");
}
