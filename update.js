#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
const AUTO_SYNC_SETTING_PATHS = ["knowledge.search"];
const VERSION_PATTERN = /^[0-9]+(\.[0-9]+){1,2}([-+][0-9A-Za-z.-]+)?$/;

function log(message) {
  console.log(`[update] ${message}`);
}

function fail(message) {
  console.error(`[update] ERROR: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: scriptDir,
    encoding: "utf-8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    if (opts.allowFailure) {
      return { ok: false, out: "", err: result.error.message, status: 1 };
    }
    fail(`${cmd} 执行失败：${result.error.message}`);
  }

  const ok = result.status === 0;
  const out = (result.stdout ?? "").trim();
  const err = (result.stderr ?? "").trim();
  if (!ok && !opts.allowFailure) {
    fail(`${cmd} ${args.join(" ")} 失败${err ? `：${err}` : ""}`);
  }
  return { ok, out, err, status: result.status ?? 1 };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readSourceVersion() {
  const pkg = readJson(join(scriptDir, "package.json"));
  return pkg.version;
}

function readBuildCommit() {
  const path = join(scriptDir, "dist", "build-info.json");
  if (!existsSync(path)) return "";
  const info = readJson(path);
  return typeof info.gitCommit === "string" ? info.gitCommit : "";
}

function readInstalledVersion() {
  const result = run("mori", ["--version"], {
    capture: true,
    allowFailure: true,
  });
  const firstLine = result.out.split("\n")[0]?.trim() ?? "";
  return VERSION_PATTERN.test(firstLine) ? firstLine : "1.0.0";
}

function outputContainsRunning(text) {
  return text.includes("运行中");
}

function isDaemonRunning() {
  const distMain = join(scriptDir, "dist", "main.js");
  if (existsSync(distMain)) {
    const result = run(process.execPath, [distMain, "status"], {
      capture: true,
      allowFailure: true,
    });
    if (outputContainsRunning(`${result.out}\n${result.err}`)) return true;
  }

  const result = run("mori", ["status"], {
    capture: true,
    allowFailure: true,
  });
  return outputContainsRunning(`${result.out}\n${result.err}`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(source, path) {
  let current = source;
  for (const key of path.split(".")) {
    if (!isPlainObject(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function fillMissingPath(target, source, path) {
  const sourceValue = valueAtPath(source, path);
  if (sourceValue === undefined) return false;

  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (next === undefined) {
      cursor[key] = {};
      cursor = cursor[key];
      continue;
    }
    if (!isPlainObject(next)) return false;
    cursor = next;
  }

  const leaf = keys[keys.length - 1];
  if (leaf in cursor) return false;
  cursor[leaf] = JSON.parse(JSON.stringify(sourceValue));
  return true;
}

function migrateSetting(current, example) {
  const migrated = [];
  if (
    isPlainObject(current.llm) &&
    isPlainObject(current.llm.routes) &&
    !("chat_types" in current.llm) &&
    isPlainObject(example.llm?.chat_types)
  ) {
    current.llm.chat_types = JSON.parse(JSON.stringify(example.llm.chat_types));
    migrated.push("llm.chat_types");
  }
  return migrated;
}

function syncSettingFields() {
  const settingPath = join(homedir(), ".mori", "setting.json");
  if (!existsSync(settingPath)) {
    log("setting.json 不存在，跳过补全字段。");
    return;
  }

  const example = readJson(join(scriptDir, "data", "setting.example.json"));
  const current = readJson(settingPath);
  const added = [];
  const migrated = migrateSetting(current, example);

  for (const path of AUTO_SYNC_SETTING_PATHS) {
    if (fillMissingPath(current, example, path)) added.push(path);
  }

  if (migrated.length === 0 && added.length === 0) {
    log("setting.json 无需补全字段。");
    return;
  }

  writeFileSync(settingPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  if (migrated.length > 0) {
    log("已迁移 setting.json 字段：");
    for (const path of migrated) log(`  ~ ${path}`);
  }
  if (added.length === 0) return;
  log(`已为 setting.json 补全 ${added.length} 个字段：`);
  for (const path of added) log(`  + ${path}`);
}

function shortCommit(commit) {
  return commit.slice(0, 7);
}

if (process.env.MORI_DEV) {
  fail("dev 模式不支持 update.js，请直接用 git/pnpm 操作仓库。");
}

const gitRoot = run("git", ["rev-parse", "--show-toplevel"], {
  capture: true,
  allowFailure: true,
});
if (!gitRoot.ok) fail("当前目录不是 git 工作副本。");
if (realpathSync(gitRoot.out) !== scriptDir) {
  fail("update.js 必须在 mori 仓库根目录运行。");
}

const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  capture: true,
}).out;
if (branch === "HEAD") {
  fail("当前不在 git 分支上（detached HEAD），无法自动更新。");
}

const oldHead = run("git", ["rev-parse", "HEAD"], { capture: true }).out;
const installedVersion = readInstalledVersion();

log(`拉取 ${branch}：git pull --rebase --autostash`);
const pull = run("git", ["pull", "--rebase", "--autostash"], {
  allowFailure: true,
});
if (!pull.ok) {
  fail("拉取失败或 autostash 产生冲突；请处理冲突后重试。");
}

const newHead = run("git", ["rev-parse", "HEAD"], { capture: true }).out;
const sourceVersion = readSourceVersion();
const builtCommit = readBuildCommit();
const localChanges = run(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { capture: true },
).out;

const reasons = [];
if (oldHead !== newHead) {
  reasons.push(`代码 ${shortCommit(oldHead)} -> ${shortCommit(newHead)}`);
}
if (installedVersion !== sourceVersion) {
  reasons.push(`已安装版本 ${installedVersion} -> 源码版本 ${sourceVersion}`);
}
if (!builtCommit) {
  reasons.push("当前产物缺少 build-info");
} else if (builtCommit !== newHead) {
  reasons.push(`当前产物 ${shortCommit(builtCommit)} -> 源码 ${shortCommit(newHead)}`);
}
if (localChanges) {
  reasons.push("存在本地 tracked 改动，重新构建当前工作树");
}
if (!existsSync(join(scriptDir, "node_modules"))) {
  reasons.push("node_modules 缺失");
}

if (reasons.length === 0) {
  log("源码、产物和已安装版本一致，无需更新。");
  process.exit(0);
}

log("需要刷新产物：");
for (const reason of reasons) log(`  - ${reason}`);

const wasRunning = isDaemonRunning();

log("pnpm install --frozen-lockfile");
run("pnpm", ["install", "--frozen-lockfile"]);

log("pnpm build");
run("pnpm", ["build"]);

syncSettingFields();

if (wasRunning) {
  log("重启 daemon");
  run(process.execPath, [join(scriptDir, "dist", "main.js"), "stop"]);
  run(process.execPath, [join(scriptDir, "dist", "main.js"), "start"]);
} else {
  log("daemon 原本未运行，仅更新代码和产物。");
}

log(`更新完成：${installedVersion} -> ${sourceVersion}`);
