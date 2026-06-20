import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getDb, initDb, closeDb } from "../src/storage/db.js";
import { loadLlmConfig, resolveModelRoute, sessionsDir } from "../src/config.js";
import { HarnessManager } from "../src/agent/harness.js";
import { FixedMutableClock } from "../src/clock.js";
import type { IngestedMessage } from "../src/ingest/message.js";
import { distillDiaryEntry } from "../src/diary/distill.js";
import { runDailyMemoryForDate } from "../src/memory/daily-memory.js";
import { runWeeklyConsolidationForWindow } from "../src/memory/consolidation.js";
import { shanghaiDateStart, shanghaiDateKey } from "../src/utils.js";

type Granularity = "per-section" | "per-day";

interface CliOptions {
  dir: string;
  granularity: Granularity;
  dryRun: boolean;
}

interface DiaryImportEntry {
  dateKey: string;
  file: string;
  message: IngestedMessage;
}

function parseArgs(argv: string[]): CliOptions | "help" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const perDay = argv.includes("--per-day");
  const perSection = argv.includes("--per-section");
  if (perDay && perSection) {
    throw new Error("--per-day 和 --per-section 只能选择一个");
  }
  const dryRun = argv.includes("--dry-run");
  const dir = argv.find((arg) => !arg.startsWith("--")) ?? "diary-data";
  return {
    dir,
    granularity: perDay ? "per-day" : "per-section",
    dryRun,
  };
}

function printHelp(): void {
  console.log(`Usage:
  PERSONAL_AGENT_DEV=1 pnpm tsx scripts/backfill-diary.ts [diary-dir] [--per-section|--per-day] [--dry-run]

Default:
  diary-dir     diary-data
  granularity   --per-section

Notes:
  - Full backfill requires a fresh target DB and will abort if memory tables are non-empty.
  - --dry-run only parses Markdown and prints counts; it does not open or write the DB.`);
}

function listDiaryFiles(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`日记目录不存在: ${dir}`);
  const result: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) {
        result.push(path);
      }
    }
  };
  visit(dir);
  return result.sort();
}

function parseDiaryFiles(dir: string, granularity: Granularity): DiaryImportEntry[] {
  return listDiaryFiles(dir).flatMap((file) => parseDiaryFile(file, granularity));
}

function parseDiaryFile(file: string, granularity: Granularity): DiaryImportEntry[] {
  const dateKey = parseDateKey(file);
  const raw = readFileSync(file, "utf-8").trim();
  if (!raw) return [];
  if (granularity === "per-day") {
    return [
      makeEntry({
        dateKey,
        file,
        idSuffix: "09-00",
        occurredAt: shanghaiLocalIso(dateKey, "09", "00"),
        content: raw,
      }),
    ];
  }
  return parseSections(file, dateKey, raw);
}

function parseSections(file: string, dateKey: string, raw: string): DiaryImportEntry[] {
  const headingPattern = /^###\s*(\d{1,2}):(\d{2})\s*$/gm;
  const matches = [...raw.matchAll(headingPattern)];
  if (matches.length === 0) {
    return [
      makeEntry({
        dateKey,
        file,
        idSuffix: "09-00",
        occurredAt: shanghaiLocalIso(dateKey, "09", "00"),
        content: raw,
      }),
    ];
  }

  const entries: DiaryImportEntry[] = [];
  const prelude = raw.slice(0, matches[0].index).trim();
  if (prelude) {
    entries.push(makeEntry({
      dateKey,
      file,
      idSuffix: "09-00:prelude",
      occurredAt: shanghaiLocalIso(dateKey, "09", "00"),
      content: prelude,
    }));
  }

  const minuteCounts = new Map<string, number>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const hour = match[1].padStart(2, "0");
    const minute = match[2];
    assertTime(file, hour, minute);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[i + 1]?.index ?? raw.length;
    const content = raw.slice(start, end).trim();
    if (!content) continue;

    const minuteKey = `${hour}-${minute}`;
    const count = (minuteCounts.get(minuteKey) ?? 0) + 1;
    minuteCounts.set(minuteKey, count);
    const suffix = count === 1 ? minuteKey : `${minuteKey}:${String(count).padStart(2, "0")}`;
    entries.push(makeEntry({
      dateKey,
      file,
      idSuffix: suffix,
      occurredAt: shanghaiLocalIso(dateKey, hour, minute),
      content,
    }));
  }

  return entries;
}

function makeEntry(opts: {
  dateKey: string;
  file: string;
  idSuffix: string;
  occurredAt: string;
  content: string;
}): DiaryImportEntry {
  return {
    dateKey: opts.dateKey,
    file: opts.file,
    message: {
      id: `import:diary:${opts.dateKey}:${opts.idSuffix}`,
      source: "import",
      conversationId: "import:diary",
      conversationType: "diary",
      role: "user",
      content: opts.content,
      occurredAt: opts.occurredAt,
      replyTo: null,
      threadId: null,
      rootId: null,
    },
  };
}

function parseDateKey(file: string): string {
  const match = basename(file).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!match) throw new Error(`无法从文件名解析日期: ${file}`);
  return match[1];
}

function assertTime(file: string, hour: string, minute: string): void {
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) {
    throw new Error(`无效时间标题 ${hour}:${minute}: ${file}`);
  }
}

function shanghaiLocalIso(dateKey: string, hour: string, minute: string): string {
  return new Date(`${dateKey}T${hour}:${minute}:00+08:00`).toISOString();
}

function assertFreshDb(db: ReturnType<typeof getDb>): void {
  const tables = [
    "messages",
    "episodes",
    "daily_memory_runs",
    "storylines",
    "storyline_revisions",
    "weekly_summaries",
    "profile_revisions",
    "agent_runs",
  ];
  const nonEmpty = tables.flatMap((table) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count > 0 ? [`${table}=${row.count}`] : [];
  });
  if (nonEmpty.length > 0) {
    throw new Error(`目标 DB 不是 fresh DB，已停止：${nonEmpty.join(", ")}`);
  }
}

function groupByDate(entries: DiaryImportEntry[]): Map<string, DiaryImportEntry[]> {
  const groups = new Map<string, DiaryImportEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.dateKey) ?? [];
    group.push(entry);
    groups.set(entry.dateKey, group);
  }
  return groups;
}

function eachDateKey(startDateKey: string, endDateKey: string): string[] {
  const dates: string[] = [];
  let cursor = shanghaiDateStart(startDateKey);
  const end = shanghaiDateStart(endDateKey);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(shanghaiDateKey(cursor));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

function eachIsoWeekWindow(startDateKey: string, endDateKey: string): Array<{ since: string; until: string }> {
  const windows: Array<{ since: string; until: string }> = [];
  let weekStart = isoWeekStartDateKey(startDateKey);
  const lastWeekStart = isoWeekStartDateKey(endDateKey);
  while (weekStart <= lastWeekStart) {
    const nextWeekStart = addDaysDateKey(weekStart, 7);
    windows.push({
      since: shanghaiDateStart(weekStart).toISOString(),
      until: shanghaiDateStart(nextWeekStart).toISOString(),
    });
    weekStart = nextWeekStart;
  }
  return windows;
}

function isoWeekStartDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const offset = (dow + 6) % 7;
  return utcDateKey(year, month - 1, day - offset);
}

function addDaysDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return utcDateKey(year, month - 1, day + days);
}

function utcDateKey(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function maxDateKey(a: string, b: string): string {
  return a > b ? a : b;
}

function minDateKey(a: string, b: string): string {
  return a < b ? a : b;
}

function printDryRun(entries: DiaryImportEntry[]): void {
  const groups = groupByDate(entries);
  console.log(`解析完成：${groups.size} 天，${entries.length} 条 message`);
  for (const [dateKey, items] of groups) {
    console.log(`${dateKey}: ${items.length}`);
  }
}

function printStats(db: ReturnType<typeof getDb>): void {
  const scalar = (sql: string): number => {
    const row = db.prepare(sql).get() as { count: number };
    return row.count;
  };
  const storylines = db
    .prepare("SELECT status, COUNT(*) AS count FROM storylines GROUP BY status ORDER BY status")
    .all() as Array<{ status: string; count: number }>;
  console.log("\nBackfill stats:");
  console.log(`messages(import): ${scalar("SELECT COUNT(*) AS count FROM messages WHERE source = 'import'")}`);
  console.log(`episodes: ${scalar("SELECT COUNT(*) AS count FROM episodes")}`);
  console.log(`daily runs: ${scalar("SELECT COUNT(*) AS count FROM daily_memory_runs")}`);
  console.log(`storylines: ${storylines.map((row) => `${row.status}=${row.count}`).join(", ") || "0"}`);
  console.log(`weekly summaries: ${scalar("SELECT COUNT(*) AS count FROM weekly_summaries")}`);
  console.log(`profile revisions: ${scalar("SELECT COUNT(*) AS count FROM profile_revisions")}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    printHelp();
    return;
  }

  const entries = parseDiaryFiles(parsed.dir, parsed.granularity);
  if (parsed.dryRun) {
    printDryRun(entries);
    return;
  }
  if (entries.length === 0) {
    throw new Error(`没有可导入的日记内容: ${parsed.dir}`);
  }

  const firstDateKey = entries[0].dateKey;
  const lastDateKey = entries[entries.length - 1].dateKey;
  const clock = new FixedMutableClock(new Date(entries[0].message.occurredAt));
  const db = getDb();
  try {
    db.pragma("busy_timeout = 10000");
    initDb(db, clock);
    assertFreshDb(db);

    const llmConfig = loadLlmConfig();
    const harnessManager = new HarnessManager({
      db,
      sessionsDir,
      clock,
      routes: {
        companion: { name: "companion", ...resolveModelRoute("companion", llmConfig) },
        weekly: { name: "weekly", ...resolveModelRoute("weekly", llmConfig) },
      },
    });

    const groups = groupByDate(entries);
    let imported = 0;
    for (const [dateKey, items] of groups) {
      const sessionScope = `import:diary:${dateKey}`;
      for (const item of items) {
        clock.set(new Date(item.message.occurredAt));
        const result = await distillDiaryEntry({
          harnessManager,
          message: item.message,
          sessionScope,
        });
        imported++;
        const marker = result.fallbackReason ? "fallback" : "ok";
        console.log(`[import ${imported}/${entries.length}] ${item.message.id} ${marker}`);
      }
      await harnessManager.resetSession(sessionScope);
    }

    for (const window of eachIsoWeekWindow(firstDateKey, lastDateKey)) {
      const startDateKey = maxDateKey(shanghaiDateKey(new Date(window.since)), firstDateKey);
      const endDateKey = minDateKey(
        shanghaiDateKey(new Date(new Date(window.until).getTime() - 1)),
        lastDateKey,
      );
      for (const dateKey of eachDateKey(startDateKey, endDateKey)) {
        await runDailyMemoryForDate({
          db,
          harnessManager,
          dateKey,
          clock,
          nudge: false,
        });
      }

      await runWeeklyConsolidationForWindow({
        db,
        harnessManager,
        clock,
        since: window.since,
        until: window.until,
        sendCards: false,
        friendRound: false,
      });
    }

    printStats(db);
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
