#!/usr/bin/env node
// 源码部署自更新：git pull，必要时重新 install/build，并按需重启 daemon。
// 从 <repo>/.claude/skills/deploy-mori/scripts/ 运行，自动定位仓库根（git toplevel），可在任意 cwd 调用。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
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
    cwd: repoRoot,
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
  const pkg = readJson(join(repoRoot, "package.json"));
  return pkg.version;
}

function readBuildCommit() {
  const path = join(repoRoot, "dist", "build-info.json");
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
  const distMain = join(repoRoot, "dist", "main.js");
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

function shortCommit(commit) {
  return commit.slice(0, 7);
}

if (process.env.MORI_DEV) {
  fail("dev 模式不支持自更新，请直接用 git/pnpm 操作仓库。");
}

// 定位仓库根：脚本在仓库内，git toplevel 即仓库根
const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: scriptDir,
  encoding: "utf-8",
});
if (toplevel.status !== 0) fail("脚本不在 git 工作副本内，无法定位仓库。");
const repoRoot = realpathSync(toplevel.stdout.trim());
if (
  !existsSync(join(repoRoot, "package.json")) ||
  readJson(join(repoRoot, "package.json")).name !== "@domencai/mori"
) {
  fail(`定位到的仓库 ${repoRoot} 不是 mori。`);
}

const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  capture: true,
}).out;
if (branch === "HEAD") {
  fail("当前不在 git 分支上（detached HEAD），无法自动更新。");
}

const oldHead = run("git", ["rev-parse", "HEAD"], { capture: true }).out;
const installedVersion = readInstalledVersion();

log(`仓库：${repoRoot}`);
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
if (!existsSync(join(repoRoot, "node_modules"))) {
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

if (wasRunning) {
  log("重启 daemon");
  run(process.execPath, [join(repoRoot, "dist", "main.js"), "stop"]);
  run(process.execPath, [join(repoRoot, "dist", "main.js"), "start"]);
} else {
  log("daemon 原本未运行，仅更新代码和产物。");
}

log(`更新完成：${installedVersion} -> ${sourceVersion}`);
