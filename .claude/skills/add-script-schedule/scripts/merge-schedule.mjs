#!/usr/bin/env node
// 幂等合并一条 script 调度进目标 schedules.json：
//   按 id —— 存在则浅合并更新、不存在则追加；文件缺失则新建。绝不整文件覆盖。
// 用法：
//   node merge-schedule.mjs --id <id> --name <显示名> --script <x.mjs> \
//     --cron "<cron>" --inbox <Inbox名> [--notify true|false] [--enabled true|false] [--file <path>]
// --file 默认 ~/.mori/schedules.json（生产）；开发传 ./data/schedules.json。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i] ?? "";
}
const missing = ["id", "name", "script", "cron", "inbox"].filter((k) => !args[k]);
if (missing.length) {
  console.error("缺少参数：" + missing.map((m) => "--" + m).join(", "));
  process.exit(1);
}

const file = args.file || join(homedir(), ".mori", "schedules.json");
const entry = {
  id: args.id,
  name: args.name,
  kind: "script",
  script: args.script,
  cron: args.cron,
  deliver: { notify: args.notify !== "false", inbox: args.inbox },
  enabled: args.enabled !== "false",
};

const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { schedules: [] };
cfg.schedules = cfg.schedules || [];
const i = cfg.schedules.findIndex((s) => s.id === entry.id);
if (i >= 0) cfg.schedules[i] = { ...cfg.schedules[i], ...entry };
else cfg.schedules.push(entry);

mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
console.log(`${i >= 0 ? "已更新" : "已追加"} 调度 ${entry.id} → ${file}`);
