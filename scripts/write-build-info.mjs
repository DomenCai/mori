import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const out = result.stdout.trim();
  return out || null;
}

const info = {
  name: pkg.name,
  version: pkg.version,
  builtAt: new Date().toISOString(),
  gitCommit: git(["rev-parse", "HEAD"]),
};

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(
  join(root, "dist", "build-info.json"),
  JSON.stringify(info, null, 2) + "\n",
);
