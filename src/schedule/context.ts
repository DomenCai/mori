import Database from "better-sqlite3";
import { dbPath, vaultDir } from "../config.js";
import { VaultService } from "../knowledge/vault.js";
import {
  businessDateKey,
  businessDateRange,
  setBusinessTimeZone,
} from "../utils.js";
import type { ScheduleContextName } from "./config.js";

const CONTEXT_API_VERSION = 1;
const DEFAULT_RANGE_DAYS = 7;
const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const VALID_CONTEXTS = new Set<ScheduleContextName>(["diary", "knowledge"]);

export interface ScheduleContextOptions {
  start?: string | Date;
  end?: string | Date;
}

export interface ScheduleResolvedRange {
  start: string;
  end: string;
}

export interface ScheduleDiaryReply {
  id: string;
  occurredAt: string;
  content: string;
}

export interface ScheduleDiaryEpisode {
  id: string;
  occurredAt: string;
  brief: string | null;
  analysis: unknown;
}

export interface ScheduleDiaryEntry {
  id: string;
  source: string;
  conversationId: string;
  occurredAt: string;
  localDate: string;
  content: string;
  aiReplies: ScheduleDiaryReply[];
  episodes: ScheduleDiaryEpisode[];
}

export interface ScheduleKnowledgeEntry {
  path: string;
  title: string;
  sourceType: string;
  sourceUrl?: string;
  savedAt: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ScheduleScriptContext {
  apiVersion: number;
  scheduleId: string;
  timezone: string;
  diary?: {
    export(options?: ScheduleContextOptions): Promise<ScheduleDiaryEntry[]>;
  };
  knowledge?: {
    export(options?: ScheduleContextOptions): Promise<ScheduleKnowledgeEntry[]>;
  };
}

interface BuildScheduleContextArgs {
  scheduleId: string;
  context?: unknown;
  timezone: string;
}

interface MessageRow {
  id: string;
  source: string;
  conversation_id: string;
  content: string;
  occurred_at: string;
}

interface ReplyRow {
  id: string;
  content: string;
  occurred_at: string;
}

interface EpisodeRow {
  id: string;
  brief: string | null;
  analysis_json: string;
  occurred_at: string;
}

export function normalizeScheduleContextNames(input: unknown): ScheduleContextName[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new Error("schedule context 必须是数组");
  }
  const names: ScheduleContextName[] = [];
  for (const value of input) {
    if (typeof value !== "string" || !VALID_CONTEXTS.has(value as ScheduleContextName)) {
      throw new Error(`未知 schedule context: ${String(value)}`);
    }
    const name = value as ScheduleContextName;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function buildScheduleScriptContext(
  args: BuildScheduleContextArgs,
): ScheduleScriptContext {
  const names = normalizeScheduleContextNames(args.context);
  setBusinessTimeZone(args.timezone);
  const ctx: ScheduleScriptContext = {
    apiVersion: CONTEXT_API_VERSION,
    scheduleId: args.scheduleId,
    timezone: args.timezone,
  };

  if (names.includes("diary")) {
    ctx.diary = {
      export: async (options) => exportDiary(options, args.timezone),
    };
  }

  if (names.includes("knowledge")) {
    ctx.knowledge = {
      export: async (options) => exportKnowledge(options, args.timezone),
    };
  }

  return ctx;
}

export function resolveScheduleContextRange(
  options: ScheduleContextOptions | undefined,
  timezone: string,
): ScheduleResolvedRange {
  setBusinessTimeZone(timezone);
  const end = options?.end ? parseRangeEndpoint(options.end, "end") : new Date();
  const start = options?.start
    ? parseRangeEndpoint(options.start, "start")
    : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (start.getTime() > end.getTime()) {
    throw new Error(`start 不能晚于 end: ${start.toISOString()} > ${end.toISOString()}`);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function parseRangeEndpoint(value: string | Date, side: "start" | "end"): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("无效时间范围");
    return value;
  }
  if (DATE_ONLY.test(value)) {
    const range = businessDateRange(value);
    return new Date(side === "start" ? range.startIso : range.endIso);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`无效时间范围: ${value}`);
  }
  return date;
}

function exportDiary(
  options: ScheduleContextOptions | undefined,
  timezone: string,
): ScheduleDiaryEntry[] {
  const range = resolveScheduleContextRange(options, timezone);
  return withReadonlyDb((db) => {
    const messages = db
      .prepare(
        `SELECT id, source, conversation_id, content, occurred_at
         FROM messages
         WHERE conversation_type = 'diary'
           AND role = 'user'
           AND occurred_at >= ?
           AND occurred_at < ?
         ORDER BY occurred_at ASC, id ASC`,
      )
      .all(range.start, range.end) as MessageRow[];

    const replyStmt = db.prepare(
      `SELECT id, content, occurred_at
       FROM messages
       WHERE role = 'assistant'
         AND reply_to = ?
       ORDER BY occurred_at ASC, id ASC`,
    );
    const episodeStmt = db.prepare(
      `SELECT id, brief, analysis_json, occurred_at
       FROM episodes
       WHERE source_message_id = ?
       ORDER BY occurred_at ASC, id ASC`,
    );

    return messages.map((message) => ({
      id: message.id,
      source: message.source,
      conversationId: message.conversation_id,
      occurredAt: message.occurred_at,
      localDate: businessDateKey(new Date(message.occurred_at)),
      content: message.content,
      aiReplies: (replyStmt.all(message.id) as ReplyRow[]).map((reply) => ({
        id: reply.id,
        occurredAt: reply.occurred_at,
        content: reply.content,
      })),
      episodes: (episodeStmt.all(message.id) as EpisodeRow[]).map((episode) => ({
        id: episode.id,
        occurredAt: episode.occurred_at,
        brief: episode.brief,
        analysis: parseJson(episode.analysis_json),
      })),
    }));
  });
}

function exportKnowledge(
  options: ScheduleContextOptions | undefined,
  timezone: string,
): ScheduleKnowledgeEntry[] {
  const range = resolveScheduleContextRange(options, timezone);
  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  const vault = new VaultService(vaultDir);
  return vault
    .listFrontmatterReadonly()
    .filter((file) => {
      const savedAt = String(file.frontmatter.saved_at ?? "");
      const savedMs = Date.parse(savedAt);
      return Number.isFinite(savedMs) && savedMs >= startMs && savedMs < endMs;
    })
    .sort((a, b) =>
      Date.parse(String(a.frontmatter.saved_at ?? ""))
      - Date.parse(String(b.frontmatter.saved_at ?? "")))
    .map((file) => {
      const full = vault.read(file.path);
      return {
        path: full.path,
        title: String(full.frontmatter.title ?? full.path),
        sourceType: String(full.frontmatter.source_type ?? ""),
        sourceUrl: asOptionalString(full.frontmatter.source_url),
        savedAt: String(full.frontmatter.saved_at ?? ""),
        frontmatter: full.frontmatter,
        body: full.body,
      };
    });
}

function withReadonlyDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
