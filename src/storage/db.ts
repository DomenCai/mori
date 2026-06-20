import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath as defaultDbPath } from "../config.js";
import { EMPTY_PROFILE } from "../memory/service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(path: string = defaultDbPath): Database.Database {
  if (_db) return _db;
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export function initDb(db: Database.Database): void {
  const schema = readSchema();
  db.exec(schema);

  const profileExists = db
    .prepare("SELECT 1 FROM profile WHERE id = 1")
    .get();
  if (!profileExists) {
    db.prepare(
      "INSERT INTO profile (id, content, updated_at) VALUES (1, ?, ?)",
    ).run(EMPTY_PROFILE, new Date().toISOString());
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
