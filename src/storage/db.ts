import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dbPath as defaultDbPath } from "../config.js";

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
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);

  const profileExists = db
    .prepare("SELECT 1 FROM profile WHERE id = 1")
    .get();
  if (!profileExists) {
    db.prepare(
      "INSERT INTO profile (id, content, updated_at) VALUES (1, ?, ?)",
    ).run("（尚未建立身份画像）", new Date().toISOString());
  }
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
