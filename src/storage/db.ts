import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath as defaultDbPath } from "../config.js";
import { EMPTY_PROFILE } from "../memory/service.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_SCHEMA_VERSION = 1;

let _db: Database.Database | null = null;

export function getDb(path: string = defaultDbPath): Database.Database {
  if (_db) return _db;
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export function initDb(db: Database.Database, clock: Clock = systemClock): void {
  const schema = readSchema();
  db.exec(schema);
  applyDbMigrations(db);
  ensureProfileRow(db, clock);
  ensureChapterRow(db, clock);
}

function applyDbMigrations(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version >= DB_SCHEMA_VERSION) return;

  db.transaction(() => {
    if (version < 1 && !weeklySummariesHasFriendNote(db)) {
      db.exec("ALTER TABLE weekly_summaries ADD COLUMN friend_note TEXT");
    }

    db.pragma(`user_version = ${DB_SCHEMA_VERSION}`);
  })();
}

function weeklySummariesHasFriendNote(db: Database.Database): boolean {
  const cols = db
    .prepare("PRAGMA table_info(weekly_summaries)")
    .all() as Array<{ name: string }>;
  return cols.some((c) => c.name === "friend_note");
}

function ensureProfileRow(db: Database.Database, clock: Clock): void {
  const profileExists = db
    .prepare("SELECT 1 FROM profile WHERE id = 1")
    .get();
  if (!profileExists) {
    db.prepare(
      "INSERT INTO profile (id, content, updated_at) VALUES (1, ?, ?)",
    ).run(EMPTY_PROFILE, clock.nowISO());
  }
}

function ensureChapterRow(db: Database.Database, clock: Clock): void {
  const chapterExists = db
    .prepare("SELECT 1 FROM chapter WHERE id = 1")
    .get();
  if (!chapterExists) {
    db.prepare(
      "INSERT INTO chapter (id, content, updated_at) VALUES (1, ?, ?)",
    ).run("", clock.nowISO());
  }
}

function readSchema(): string {
  const candidates = [
    join(__dirname, "schema.sql"),
    join(__dirname, "../../src/storage/schema.sql"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`schema.sql 不存在：${candidates.join(", ")}`);
  }
  return readFileSync(path, "utf-8");
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
