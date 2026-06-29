import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const srcStorage = join(root, "src", "storage");
const distStorage = join(root, "dist", "storage");
const srcMigrations = join(srcStorage, "migrations");
const distMigrations = join(distStorage, "migrations");

mkdirSync(distStorage, { recursive: true });
copyFileSync(join(srcStorage, "schema.sql"), join(distStorage, "schema.sql"));

if (existsSync(srcMigrations)) {
  mkdirSync(distMigrations, { recursive: true });
  for (const name of readdirSync(srcMigrations)) {
    if (!name.endsWith(".sql")) continue;
    copyFileSync(join(srcMigrations, name), join(distMigrations, name));
  }
}
