import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type OutputMode = "text" | "json";

interface CliOptions {
  command: string;
  args: string[];
  dbPath: string;
  output: OutputMode;
  full: boolean;
  limit: number;
  status?: string;
  withSource: boolean;
}

interface Issue {
  severity: "error" | "warn";
  check: string;
  count?: number;
  details?: unknown;
}

const DEFAULT_LIMIT = 20;
const TEXT_LIMIT = 260;

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "help") {
    printHelp();
    return;
  }

  const db = openReadonlyDb(opts.dbPath);
  try {
    switch (opts.command) {
      case "summary":
        printResult(opts, buildSummary(db));
        return;
      case "integrity":
        printResult(opts, buildIntegrity(db));
        return;
      case "day":
        printResult(opts, inspectDay(db, requireArg(opts, "day", "YYYY-MM-DD"), opts));
        return;
      case "week":
        printResult(opts, inspectWeek(db, requireArg(opts, "week", "YYYY-Www"), opts));
        return;
      case "storylines":
        printResult(opts, inspectStorylines(db, opts));
        return;
      case "profile":
        printResult(opts, inspectProfile(db, opts));
        return;
      case "profile-history":
        printResult(opts, inspectProfileHistory(db, opts));
        return;
      case "episodes":
        printResult(opts, inspectEpisodes(db, opts));
        return;
      case "episode":
        printResult(opts, inspectEpisode(db, requireArg(opts, "episode", "episode-id"), opts));
        return;
      default:
        throw new Error(`未知命令: ${opts.command}`);
    }
  } finally {
    db.close();
  }
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      command: "help",
      args: [],
      dbPath: defaultDbPath(),
      output: "text",
      full: false,
      limit: DEFAULT_LIMIT,
      withSource: false,
    };
  }

  let dbPath = defaultDbPath();
  let output: OutputMode = "text";
  let full = false;
  let limit = DEFAULT_LIMIT;
  let status: string | undefined;
  let withSource = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      dbPath = requireValue(argv[++i], "--db");
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    } else if (arg === "--json") {
      output = "json";
    } else if (arg === "--full") {
      full = true;
    } else if (arg === "--limit") {
      limit = parsePositiveInt(requireValue(argv[++i], "--limit"), "--limit");
    } else if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    } else if (arg === "--status") {
      status = requireValue(argv[++i], "--status");
    } else if (arg.startsWith("--status=")) {
      status = arg.slice("--status=".length);
    } else if (arg === "--with-source") {
      withSource = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] ?? "summary",
    args: positional.slice(1),
    dbPath: resolve(dbPath),
    output,
    full,
    limit,
    status,
    withSource,
  };
}

function printHelp(): void {
  console.log(`Usage:
  MORI_DEV=1 pnpm tsx scripts/inspect-db.ts [command] [options]

Commands:
  summary                         数据库整体概览（默认）
  integrity                       只读完整性检查
  day YYYY-MM-DD                  查看某天 messages / episodes / daily memory
  week YYYY-Www                   查看某周 daily / weekly / profile changes
  storylines [--status active]    查看 storylines
  profile                         查看当前画像
  profile-history [--limit 10]    查看画像变更历史
  episodes [--limit 20]           查看最近 episodes
  episode <id> [--with-source]    查看单条 episode

Options:
  --db <path>       指定 SQLite 文件。默认开发态为 data/app.db，生产态为 ~/.mori/app.db
  --json            输出 JSON
  --full            不截断长文本
  --limit <n>       列表条数，默认 ${DEFAULT_LIMIT}
  --status <value>  storylines 状态过滤：active / dormant / closed
  --with-source     episode 详情同时显示来源消息`);
}

function defaultDbPath(): string {
  return process.env.MORI_DEV
    ? join(process.cwd(), "data", "app.db")
    : join(homedir(), ".mori", "app.db");
}

function openReadonlyDb(path: string): Database.Database {
  if (!existsSync(path)) {
    throw new Error(`数据库不存在: ${path}`);
  }
  return new Database(path, { readonly: true, fileMustExist: true });
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} 缺少参数`);
  return value;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return parsed;
}

function requireArg(opts: CliOptions, command: string, label: string): string {
  const value = opts.args[0];
  if (!value) throw new Error(`${command} 需要参数: ${label}`);
  return value;
}

function printResult(opts: CliOptions, value: unknown): void {
  if (opts.output === "json") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
  } else {
    console.log(formatValue(value, opts));
  }
}

function buildSummary(db: Database.Database): Record<string, unknown> {
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
  const counts = Object.fromEntries(
    tables.map((table) => [table, scalar(db, `SELECT COUNT(*) AS count FROM ${table}`)]),
  );

  return {
    db: db.name,
    counts,
    messagesBySource: all(db, "SELECT source, role, COUNT(*) AS count FROM messages GROUP BY source, role ORDER BY source, role"),
    storylinesByStatus: all(db, "SELECT status, COUNT(*) AS count FROM storylines GROUP BY status ORDER BY status"),
    dailyRange: get(db, "SELECT MIN(date_key) AS min, MAX(date_key) AS max FROM daily_memory_runs"),
    weeklyRange: get(db, "SELECT MIN(week_key) AS min, MAX(week_key) AS max FROM weekly_summaries"),
    undigestedEpisodes: scalar(db, "SELECT COUNT(*) AS count FROM episodes WHERE digested_run_id IS NULL"),
    failedDailyRuns: scalar(db, "SELECT COUNT(*) AS count FROM daily_memory_runs WHERE status != 'completed'"),
    latestWeekly: get(db, "SELECT week_key, created_at, length(summary) AS summary_len FROM weekly_summaries ORDER BY week_key DESC LIMIT 1"),
    profileUpdatedAt: get(db, "SELECT updated_at FROM profile WHERE id = 1")?.updated_at ?? null,
  };
}

function buildIntegrity(db: Database.Database): { ok: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  pushCountIssue(
    issues,
    "error",
    "messages_without_episode",
    scalar(
      db,
      `SELECT COUNT(*) AS count
       FROM messages m
       WHERE m.role = 'user'
         AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.source_message_id = m.id)`,
    ),
    sample(
      db,
      `SELECT m.id, m.source, m.conversation_type, m.occurred_at
       FROM messages m
       WHERE m.role = 'user'
         AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.source_message_id = m.id)
       ORDER BY m.occurred_at DESC LIMIT 20`,
    ),
  );
  pushCountIssue(
    issues,
    "error",
    "episodes_missing_source_message",
    scalar(
      db,
      `SELECT COUNT(*) AS count
       FROM episodes e
       WHERE e.source_message_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = e.source_message_id)`,
    ),
    sample(
      db,
      `SELECT e.id, e.source_message_id, e.occurred_at
       FROM episodes e
       WHERE e.source_message_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = e.source_message_id)
       ORDER BY e.occurred_at DESC LIMIT 20`,
    ),
  );
  pushCountIssue(
    issues,
    "warn",
    "undigested_episodes",
    scalar(db, "SELECT COUNT(*) AS count FROM episodes WHERE digested_run_id IS NULL"),
    sample(
      db,
      `SELECT id, source_message_id, occurred_at, brief
       FROM episodes WHERE digested_run_id IS NULL
       ORDER BY occurred_at DESC LIMIT 20`,
    ),
  );
  pushCountIssue(
    issues,
    "error",
    "failed_daily_memory_runs",
    scalar(db, "SELECT COUNT(*) AS count FROM daily_memory_runs WHERE status != 'completed'"),
    sample(
      db,
      `SELECT date_key, status, error
       FROM daily_memory_runs WHERE status != 'completed'
       ORDER BY date_key DESC LIMIT 20`,
    ),
  );
  pushCountIssue(
    issues,
    "warn",
    "invalid_json_fields",
    countInvalidJsonFields(db),
  );

  const dailyGaps = findDailyGaps(db);
  if (dailyGaps.length > 0) {
    issues.push({
      severity: "warn",
      check: "daily_memory_date_gaps",
      count: dailyGaps.length,
      details: dailyGaps.slice(0, 20),
    });
  }

  const weeklyGaps = findWeeklyGaps(db);
  if (weeklyGaps.length > 0) {
    issues.push({
      severity: "warn",
      check: "weekly_summary_gaps",
      count: weeklyGaps.length,
      details: weeklyGaps.slice(0, 20),
    });
  }

  return { ok: issues.length === 0, issues };
}

function pushCountIssue(
  issues: Issue[],
  severity: Issue["severity"],
  check: string,
  count: number,
  details?: unknown,
): void {
  if (count > 0) {
    issues.push({ severity, check, count, details });
  }
}

function inspectDay(db: Database.Database, dateKey: string, opts: CliOptions): Record<string, unknown> {
  assertDateKey(dateKey);
  const { since, until } = shanghaiDayWindow(dateKey);
  const run = get(
    db,
    `SELECT * FROM daily_memory_runs WHERE date_key = ?`,
    dateKey,
  );
  const messages = all(
    db,
    `SELECT id, source, conversation_id, conversation_type, role, thread_id, root_id,
            occurred_at, created_at, content
     FROM messages
     WHERE occurred_at >= ? AND occurred_at < ?
     ORDER BY occurred_at ASC`,
    since,
    until,
  ).map((row) => truncateValue(row, opts));
  const episodes = all(
    db,
    `SELECT id, source_conversation_id, source_message_id, occurred_at,
            digested_run_id, created_at, brief, analysis_json
     FROM episodes
     WHERE occurred_at >= ? AND occurred_at < ?
     ORDER BY occurred_at ASC`,
    since,
    until,
  ).map((row) => truncateValue(row, opts));
  const changes = run
    ? all(
        db,
        `SELECT storyline_id, operation, reason, created_at, new_json
         FROM storyline_revisions
         WHERE run_id = ?
         ORDER BY created_at ASC`,
        run.id,
      ).map((row) => truncateValue(row, opts))
    : [];

  return {
    dateKey,
    window: { since, until },
    counts: {
      messages: messages.length,
      episodes: episodes.length,
      storylineChanges: changes.length,
      undigestedEpisodes: scalar(
        db,
        "SELECT COUNT(*) AS count FROM episodes WHERE occurred_at >= ? AND occurred_at < ? AND digested_run_id IS NULL",
        since,
        until,
      ),
    },
    messages,
    episodes,
    dailyMemoryRun: run ? truncateValue(parseRunRow(run), opts) : null,
    storylineChanges: changes,
  };
}

function inspectWeek(db: Database.Database, week: string, opts: CliOptions): Record<string, unknown> {
  const { weekKey, since, until, startDateKey, endDateKey } = weekWindow(week);
  const dailyRuns = all(
    db,
    `SELECT date_key, status, input_episode_ids_json, dream_summary,
            storyline_changes_json, nudge_evaluated, nudge_sent, error, created_at, updated_at
     FROM daily_memory_runs
     WHERE date_key >= ? AND date_key <= ?
     ORDER BY date_key ASC`,
    startDateKey,
    endDateKey,
  ).map((row) => truncateValue(parseRunRow(row), opts));
  const weeklySummary = get(
    db,
    "SELECT week_key, summary, created_at FROM weekly_summaries WHERE week_key = ?",
    weekKey,
  );
  const profileRevisions = all(
    db,
    `SELECT id, run_id, reason, source_episode_ids_json, created_at, old_content, new_content
     FROM profile_revisions
     WHERE created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
    since,
    until,
  ).map((row) => truncateValue(row, opts));
  const touchedStorylines = all(
    db,
    `SELECT DISTINCT s.id, s.title, s.kind, s.status, s.last_active_at, s.summary
     FROM storyline_revisions r
     JOIN storylines s ON s.id = r.storyline_id
     WHERE r.created_at >= ? AND r.created_at < ?
     ORDER BY s.last_active_at DESC`,
    since,
    until,
  ).map((row) => truncateValue(row, opts));

  return {
    weekKey,
    window: { since, until, startDateKey, endDateKey },
    counts: {
      messages: scalar(db, "SELECT COUNT(*) AS count FROM messages WHERE occurred_at >= ? AND occurred_at < ?", since, until),
      episodes: scalar(db, "SELECT COUNT(*) AS count FROM episodes WHERE occurred_at >= ? AND occurred_at < ?", since, until),
      dailyRuns: dailyRuns.length,
      weeklySummary: weeklySummary ? 1 : 0,
      profileRevisions: profileRevisions.length,
      touchedStorylines: touchedStorylines.length,
    },
    dailyRuns,
    weeklySummary: weeklySummary ? truncateValue(weeklySummary, opts) : null,
    profileRevisions,
    touchedStorylines,
  };
}

function inspectStorylines(db: Database.Database, opts: CliOptions): Record<string, unknown> {
  const params: unknown[] = [];
  let where = "";
  if (opts.status) {
    where = "WHERE status = ?";
    params.push(opts.status);
  }
  const rows = all(
    db,
    `SELECT id, kind, title, status, summary, current_tension, emotional_arc,
            people_json, evidence_episode_ids_json, created_at, updated_at, last_active_at
     FROM storylines
     ${where}
     ORDER BY status = 'active' DESC, last_active_at DESC
     LIMIT ?`,
    ...params,
    opts.limit,
  ).map((row) => truncateValue(row, opts));

  return {
    status: opts.status ?? "all",
    count: rows.length,
    totals: all(db, "SELECT status, COUNT(*) AS count FROM storylines GROUP BY status ORDER BY status"),
    storylines: rows,
  };
}

function inspectProfile(db: Database.Database, opts: CliOptions): Record<string, unknown> {
  const row = get(db, "SELECT content, updated_at FROM profile WHERE id = 1");
  return row ? truncateValue(row, opts) : { content: null, updated_at: null };
}

function inspectProfileHistory(db: Database.Database, opts: CliOptions): Record<string, unknown> {
  const rows = all(
    db,
    `SELECT id, run_id, reason, source_episode_ids_json, created_at, old_content, new_content
     FROM profile_revisions
     ORDER BY created_at DESC
     LIMIT ?`,
    opts.limit,
  ).map((row) => truncateValue(row, opts));
  return { count: rows.length, revisions: rows };
}

function inspectEpisodes(db: Database.Database, opts: CliOptions): Record<string, unknown> {
  const rows = all(
    db,
    `SELECT id, source_conversation_id, source_message_id, occurred_at,
            digested_run_id, created_at, brief, analysis_json
     FROM episodes
     ORDER BY occurred_at DESC
     LIMIT ?`,
    opts.limit,
  ).map((row) => truncateValue(row, opts));
  return { count: rows.length, episodes: rows };
}

function inspectEpisode(db: Database.Database, id: string, opts: CliOptions): Record<string, unknown> {
  const episode = get(
    db,
    `SELECT id, source_conversation_id, source_message_id, source_started_at, source_ended_at,
            occurred_at, digested_run_id, created_at, brief, analysis_json
     FROM episodes
     WHERE id = ?`,
    id,
  );
  if (!episode) throw new Error(`episode 不存在: ${id}`);

  const sourceMessages = opts.withSource
    ? all(
        db,
        `SELECT id, source, conversation_id, conversation_type, role, thread_id, root_id,
                occurred_at, created_at, content
         FROM messages
         WHERE (? IS NOT NULL AND id = ?)
            OR (? IS NULL AND conversation_id = ? AND occurred_at BETWEEN ? AND ?)
         ORDER BY occurred_at ASC`,
        episode.source_message_id,
        episode.source_message_id,
        episode.source_message_id,
        episode.source_conversation_id,
        episode.source_started_at,
        episode.source_ended_at,
      ).map((row) => truncateValue(row, opts))
    : undefined;

  return {
    episode: truncateValue(episode, opts),
    sourceMessages,
  };
}

function get(db: Database.Database, sql: string, ...params: unknown[]): Record<string, any> | null {
  return (db.prepare(sql).get(...params) as Record<string, any> | undefined) ?? null;
}

function all(db: Database.Database, sql: string, ...params: unknown[]): Array<Record<string, any>> {
  return db.prepare(sql).all(...params) as Array<Record<string, any>>;
}

function scalar(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = get(db, sql, ...params) as { count: number } | null;
  return row?.count ?? 0;
}

function sample(db: Database.Database, sql: string, ...params: unknown[]): Array<Record<string, any>> {
  return all(db, sql, ...params);
}

function truncateValue<T>(value: T, opts: CliOptions): T {
  if (opts.full) return value;
  if (typeof value === "string") return truncate(value, TEXT_LIMIT) as T;
  if (Array.isArray(value)) {
    return value.map((item) => truncateValue(item, opts)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        truncateValue(nested, opts),
      ]),
    ) as T;
  }
  return value;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function parseRunRow(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    input_episode_ids_json: parseJsonSafe(row.input_episode_ids_json),
    storyline_changes_json: parseJsonSafe(row.storyline_changes_json),
  };
}

function parseJsonSafe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function countInvalidJsonFields(db: Database.Database): number {
  const checks = [
    ["episodes", "analysis_json"],
    ["profile_revisions", "source_episode_ids_json"],
    ["storylines", "people_json"],
    ["storylines", "evidence_episode_ids_json"],
    ["storyline_revisions", "new_json"],
    ["storyline_revisions", "source_episode_ids_json"],
    ["daily_memory_runs", "input_episode_ids_json"],
    ["daily_memory_runs", "storyline_changes_json"],
    ["agent_runs", "tool_calls_json"],
  ];
  let count = 0;
  for (const [table, column] of checks) {
    count += scalar(db, `SELECT COUNT(*) AS count FROM ${table} WHERE json_valid(${column}) = 0`);
  }
  count += scalar(
    db,
    "SELECT COUNT(*) AS count FROM storyline_revisions WHERE old_json IS NOT NULL AND json_valid(old_json) = 0",
  );
  return count;
}

function findDailyGaps(db: Database.Database): string[] {
  const range = get(db, "SELECT MIN(date_key) AS min, MAX(date_key) AS max FROM daily_memory_runs");
  if (!range?.min || !range?.max) return [];
  const existing = new Set(
    all(db, "SELECT date_key FROM daily_memory_runs").map((row) => row.date_key as string),
  );
  const result: string[] = [];
  for (let cursor = range.min; cursor <= range.max; cursor = addDaysDateKey(cursor, 1)) {
    if (!existing.has(cursor)) result.push(cursor);
  }
  return result;
}

function findWeeklyGaps(db: Database.Database): string[] {
  const rows = all(db, "SELECT week_key FROM weekly_summaries ORDER BY week_key ASC").map(
    (row) => row.week_key as string,
  );
  if (rows.length < 2) return [];
  const expected = new Set<string>();
  let cursor = weekStartDateKey(rows[0]);
  const last = weekStartDateKey(rows[rows.length - 1]);
  while (cursor <= last) {
    expected.add(formatWeekKey(new Date(`${cursor}T00:00:00Z`)));
    cursor = addDaysDateKey(cursor, 7);
  }
  return [...expected].filter((key) => !rows.includes(key));
}

function assertDateKey(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`日期必须是 YYYY-MM-DD: ${value}`);
  }
}

function shanghaiDayWindow(dateKey: string): { since: string; until: string } {
  return {
    since: new Date(`${dateKey}T00:00:00+08:00`).toISOString(),
    until: new Date(`${addDaysDateKey(dateKey, 1)}T00:00:00+08:00`).toISOString(),
  };
}

function weekWindow(week: string): {
  weekKey: string;
  since: string;
  until: string;
  startDateKey: string;
  endDateKey: string;
} {
  if (!/^\d{4}-W\d{2}$/.test(week)) {
    throw new Error(`周必须是 YYYY-Www: ${week}`);
  }
  const startDateKey = weekStartDateKey(week);
  const untilDateKey = addDaysDateKey(startDateKey, 7);
  return {
    weekKey: week,
    since: new Date(`${startDateKey}T00:00:00+08:00`).toISOString(),
    until: new Date(`${untilDateKey}T00:00:00+08:00`).toISOString(),
    startDateKey,
    endDateKey: addDaysDateKey(untilDateKey, -1),
  };
}

function weekStartDateKey(week: string): string {
  const [yearText, weekText] = week.split("-W");
  const year = Number(yearText);
  const weekNumber = Number(weekText);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const monday = new Date(Date.UTC(year, 0, 4 - jan4Dow + 1 + (weekNumber - 1) * 7));
  return monday.toISOString().slice(0, 10);
}

function formatWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function addDaysDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function formatValue(value: unknown, opts: CliOptions): string {
  return JSON.stringify(value, null, 2);
}

main();
