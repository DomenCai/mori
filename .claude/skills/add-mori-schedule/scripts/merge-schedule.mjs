#!/usr/bin/env node
// 幂等合并一条 mori 调度进目标 schedules.json：
//   按 id —— 存在则浅合并更新、不存在则追加；文件缺失则新建。绝不整文件覆盖。
// 用法：
//   script:
//     node merge-schedule.mjs --id <id> --name <显示名> --script <x.mjs> \
//       --cron "<cron>" [--inbox <Inbox名>] [--notify true|false] [--enabled true|false] [--file <path>]
//   agent inline:
//     node merge-schedule.mjs --kind agent --id <id> --name <显示名> --prompt "..." \
//       --cron "<cron>" [--system bare|mori|自定义] [--tools search_memory,read_vault]
//   agent script:
//     node merge-schedule.mjs --kind agent --id <id> --name <显示名> --script <x.mjs> \
//       --cron "<cron>" [--inbox <Inbox名>]
// --file 默认 ~/.mori/schedules.json（生产）；开发传 ./data/schedules.json。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i] ?? "";
}
const kind = args.kind || "script";
const missing = ["id", "name", "cron"].filter((k) => !args[k]);
if (missing.length) {
  console.error("缺少参数：" + missing.map((m) => "--" + m).join(", "));
  process.exit(1);
}
if (kind !== "script" && kind !== "agent") {
  console.error("--kind 只能是 script 或 agent");
  process.exit(1);
}
if (kind === "script" && !args.script) {
  console.error("script 调度缺少参数：--script");
  process.exit(1);
}
if (kind === "agent" && Boolean(args.script) === Boolean(args.prompt)) {
  console.error("agent 调度必须且只能提供 --script 或 --prompt");
  process.exit(1);
}

const file = args.file || join(homedir(), ".mori", "schedules.json");
const entry = {
  id: args.id,
  name: args.name,
  kind,
  cron: args.cron,
  enabled: args.enabled !== "false",
};
if (args.script) entry.script = args.script;
if (args.prompt) entry.prompt = args.prompt;
if (args.system) entry.system = args.system;
if (args.tools) entry.tools = args.tools.split(",").map((item) => item.trim()).filter(Boolean);
entry.deliver = { notify: args.notify !== "false" };
if (args.inbox) entry.deliver.inbox = args.inbox;

const existing = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
const cfg = existing ? JSON.parse(existing) : { schedules: [] };
cfg.schedules = cfg.schedules || [];
const i = cfg.schedules.findIndex((s) => s.id === entry.id);
if (i >= 0) cfg.schedules[i] = { ...cfg.schedules[i], ...entry };
else cfg.schedules.push(entry);

mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
console.log(`${i >= 0 ? "已更新" : "已追加"} 调度 ${entry.id} → ${file}`);
