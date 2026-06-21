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
import { businessDateStart, businessDateKey, weekKey } from "../src/utils.js";

type Granularity = "per-section" | "per-day";

interface CliOptions {
  dir: string;
  granularity: Granularity;
  dryRun: boolean;
  weekStart?: string;
  skipWeekly: boolean;
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
  const skipWeekly = argv.includes("--skip-weekly");
  let weekStart: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--week-start") {
      weekStart = argv[++i];
    } else if (arg.startsWith("--week-start=")) {
      weekStart = arg.slice("--week-start=".length);
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error("--week-start 必须是 YYYY-MM-DD");
  }
  const dir = positional[0] ?? "diary-data";
  return {
    dir,
    granularity: perDay ? "per-day" : "per-section",
    dryRun,
    weekStart,
    skipWeekly,
  };
}

function printHelp(): void {
  console.log(`Usage:
  PERSONAL_AGENT_DEV=1 pnpm tsx scripts/backfill-diary.ts [diary-dir] [--per-section|--per-day] [--dry-run]
  PERSONAL_AGENT_DEV=1 pnpm tsx scripts/backfill-diary.ts [diary-dir] --week-start YYYY-MM-DD [--skip-weekly]

Default:
  diary-dir     diary-data
  granularity   --per-section

Notes:
  - Full backfill requires a fresh target DB and will abort if memory tables are non-empty.
  - --week-start only processes that ISO week and can be used to advance a non-fresh DB week by week.
  - --skip-weekly imports and runs daily memory for the week without writing weekly_summaries/profile.
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
  let cursor = businessDateStart(startDateKey);
  const end = businessDateStart(endDateKey);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(businessDateKey(cursor));
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
      since: businessDateStart(weekStart).toISOString(),
      until: businessDateStart(nextWeekStart).toISOString(),
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

function count(db: ReturnType<typeof getDb>, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

function printWindowStats(
  db: ReturnType<typeof getDb>,
  opts: {
    weekKey: string;
    since: string;
    until: string;
    startDateKey: string;
    endDateKey: string;
  },
): void {
  console.log(
    `Week stats: messages=${count(db, "SELECT COUNT(*) AS count FROM messages WHERE source = 'import' AND occurred_at >= ? AND occurred_at < ?", opts.since, opts.until)}, ` +
      `episodes=${count(db, "SELECT COUNT(*) AS count FROM episodes WHERE occurred_at >= ? AND occurred_at < ?", opts.since, opts.until)}, ` +
      `daily=${count(db, "SELECT COUNT(*) AS count FROM daily_memory_runs WHERE date_key >= ? AND date_key <= ?", opts.startDateKey, opts.endDateKey)}, ` +
      `weekly=${count(db, "SELECT COUNT(*) AS count FROM weekly_summaries WHERE week_key = ?", opts.weekKey)}, ` +
      `profileRevisions=${count(db, "SELECT COUNT(*) AS count FROM profile_revisions WHERE created_at >= ? AND created_at < ?", opts.since, opts.until)}`,
  );
}

async function importEntries(opts: {
  db: ReturnType<typeof getDb>;
  harnessManager: HarnessManager;
  clock: FixedMutableClock;
  entries: DiaryImportEntry[];
}): Promise<void> {
  let imported = 0;
  let skipped = 0;
  const groups = groupByDate(opts.entries);
  for (const [dateKey, items] of groups) {
    const sessionScope = `import:diary:${dateKey}`;
    for (const item of items) {
      const existingEpisode = opts.db
        .prepare("SELECT 1 FROM episodes WHERE source_message_id = ?")
        .get(item.message.id);
      if (existingEpisode) {
        skipped++;
        console.log(`[import skip] ${item.message.id}`);
        continue;
      }
      opts.clock.set(new Date(item.message.occurredAt));
      const result = await distillDiaryEntry({
        harnessManager: opts.harnessManager,
        message: item.message,
        sessionScope,
      });
      imported++;
      const marker = result.fallbackReason ? "fallback" : "ok";
      console.log(`[import ${imported}/${opts.entries.length}] ${item.message.id} ${marker}`);
    }
    await opts.harnessManager.resetSession(sessionScope);
  }
  console.log(`Import done: imported=${imported}, skipped=${skipped}`);
}

async function runWindow(opts: {
  db: ReturnType<typeof getDb>;
  harnessManager: HarnessManager;
  clock: FixedMutableClock;
  entries: DiaryImportEntry[];
  firstDateKey: string;
  lastDateKey: string;
  since: string;
  until: string;
  skipWeekly?: boolean;
}): Promise<void> {
  const weekStartDateKey = businessDateKey(new Date(opts.since));
  const weekEndDateKey = businessDateKey(new Date(new Date(opts.until).getTime() - 1));
  const startDateKey = maxDateKey(weekStartDateKey, opts.firstDateKey);
  const endDateKey = minDateKey(weekEndDateKey, opts.lastDateKey);
  const weekEntries = opts.entries.filter(
    (entry) =>
      entry.message.occurredAt >= opts.since &&
      entry.message.occurredAt < opts.until,
  );
  const wk = weekKey(new Date(opts.since));

  console.log(`\nWeek ${wk}: ${weekStartDateKey} -> ${businessDateKey(new Date(opts.until))}`);
  console.log(`Window UTC: ${opts.since} -> ${opts.until}`);
  console.log(`Diary entries in week: ${weekEntries.length}`);
  console.log(`Daily dates: ${startDateKey} -> ${endDateKey}`);

  if (startDateKey <= endDateKey) {
    for (const dateKey of eachDateKey(startDateKey, endDateKey)) {
      const dayEntries = weekEntries.filter((entry) => entry.dateKey === dateKey);
      console.log(`\nDay ${dateKey}: diary entries=${dayEntries.length}`);
      if (dayEntries.length > 0) {
        await importEntries({
          db: opts.db,
          harnessManager: opts.harnessManager,
          clock: opts.clock,
          entries: dayEntries,
        });
      }
      await runDailyMemoryForDate({
        db: opts.db,
        harnessManager: opts.harnessManager,
        dateKey,
        clock: opts.clock,
        nudge: false,
      });
    }
  }

  const existingWeekly = opts.db
    .prepare("SELECT 1 FROM weekly_summaries WHERE week_key = ?")
    .get(wk);
  if (opts.skipWeekly) {
    console.log(`[weekly skip] ${wk} skipped by --skip-weekly`);
  } else if (existingWeekly) {
    console.log(`[weekly skip] ${wk} already exists`);
  } else {
    await runWeeklyConsolidationForWindow({
      db: opts.db,
      harnessManager: opts.harnessManager,
      clock: opts.clock,
      since: opts.since,
      until: opts.until,
      sendCards: false,
      friendRound: false,
    });
  }

  printWindowStats(opts.db, {
    weekKey: wk,
    since: opts.since,
    until: opts.until,
    startDateKey,
    endDateKey,
  });
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
    if (!parsed.weekStart) {
      assertFreshDb(db);
    }

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

    if (parsed.weekStart) {
      const since = businessDateStart(parsed.weekStart).toISOString();
      const until = businessDateStart(addDaysDateKey(parsed.weekStart, 7)).toISOString();
      await runWindow({
        db,
        harnessManager,
        clock,
        entries,
        firstDateKey,
        lastDateKey,
        since,
        until,
        skipWeekly: parsed.skipWeekly,
      });
      printStats(db);
      return;
    }

    for (const window of eachIsoWeekWindow(firstDateKey, lastDateKey)) {
      await runWindow({
        db,
        harnessManager,
        clock,
        entries,
        firstDateKey,
        lastDateKey,
        since: window.since,
        until: window.until,
        skipWeekly: parsed.skipWeekly,
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
