import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath as defaultDbPath } from "../config.js";
import { EMPTY_PROFILE } from "../memory/service.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DbMigration {
  version: number;
  path: string;
  sql: string;
}

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
  const migrations = readMigrations();
  if (hasApplicationTables(db)) {
    applyDbMigrations(db, migrations);
  } else {
    db.exec(schema);
    db.pragma(`user_version = ${latestSchemaVersion(migrations)}`);
  }
  ensureProfileRow(db, clock);
  ensureChapterRow(db, clock);
}

function applyDbMigrations(
  db: Database.Database,
  migrations: DbMigration[],
): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  const targetVersion = latestSchemaVersion(migrations);
  if (version >= targetVersion) return;

  db.transaction(() => {
    for (const migration of migrations) {
      if (version < migration.version) {
        if (shouldSkipMigration(db, migration)) continue;
        db.exec(migration.sql);
      }
    }

    db.pragma(`user_version = ${targetVersion}`);
  })();
}

function shouldSkipMigration(
  db: Database.Database,
  migration: DbMigration,
): boolean {
  return migration.version === 1 && weeklySummariesHasFriendNote(db);
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

function hasApplicationTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       LIMIT 1`,
    )
    .get();
  return Boolean(row);
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

function readMigrations(): DbMigration[] {
  const candidates = [
    join(__dirname, "migrations"),
    join(__dirname, "../../src/storage/migrations"),
  ];
  const dir = candidates.find((candidate) => existsSync(candidate));
  if (!dir) {
    throw new Error(`storage migrations 不存在：${candidates.join(", ")}`);
  }

  return readdirSync(dir)
    .map((name) => {
      const match = /^(\d+)_.*\.sql$/.exec(name);
      if (!match) return null;
      const path = join(dir, name);
      return {
        version: Number(match[1]),
        path,
        sql: readFileSync(path, "utf-8"),
      };
    })
    .filter((item): item is DbMigration => Boolean(item))
    .sort((a, b) => a.version - b.version);
}

function latestSchemaVersion(migrations: DbMigration[]): number {
  return migrations.reduce(
    (latest, migration) => Math.max(latest, migration.version),
    0,
  );
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
