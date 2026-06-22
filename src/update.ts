// 基于 git 的自更新：本机是 git 工作副本，pnpm link 安装。
// 流程：确认 clone+link 部署 → 只读远端检查/拉取 → (依赖变才) install →
// build → 同步允许自动补齐的 setting 字段 → 若原本在运行则重启。
// 失败即停、保留现场：pull/install/build 全程旧 daemon 继续服务，任一步失败都
// 不会停掉它（只有最后确认成功后才有一两秒重启窗口）。
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoDir, isDevMode, settingPath, loadAppVersion } from "./config.js";
import { isDaemonRunning, startDaemon, stopDaemon } from "./daemon.js";
import { logger } from "./log.js";

const log = logger("update");
const AUTO_SYNC_SETTING_PATHS = ["knowledge.search"];

function run(
  cmd: string,
  args: string[],
  opts: { capture?: boolean } = {},
): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizePath(path: string): string {
  return realpathSync(path);
}

interface GitState {
  branch: string;
  remote: string;
  mergeRef: string;
  upstream: string;
  localCommit: string;
}

function ensureGitWorktree(): void {
  const root = run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  if (!root.ok || normalizePath(root.out) !== normalizePath(repoDir)) {
    log.error("当前安装不是 clone+link 的 git 工作副本，不能使用 personal-agent update。");
    log.error("请改用 pnpm add -g github:... 重新安装，或在源码仓库里手动 git/pnpm 操作。");
    process.exit(1);
  }
}

function loadGitState(): GitState {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
  if (!branch.ok || branch.out === "HEAD") {
    log.error("当前不在 git 分支上（detached HEAD 或非 git 仓库），无法 update。");
    process.exit(1);
  }

  const remote = run("git", ["config", `branch.${branch.out}.remote`], { capture: true });
  const merge = run("git", ["config", `branch.${branch.out}.merge`], { capture: true });
  if (!remote.ok || !remote.out || !merge.ok || !merge.out) {
    log.error("当前分支未配置 upstream，无法 update。");
    process.exit(1);
  }

  const local = run("git", ["rev-parse", "HEAD"], { capture: true });
  if (!local.ok || !local.out) {
    log.error("无法读取本地 HEAD，无法 update。");
    process.exit(1);
  }

  const remoteBranch = merge.out.replace(/^refs\/heads\//, "");
  return {
    branch: branch.out,
    remote: remote.out,
    mergeRef: merge.out,
    upstream: `${remote.out}/${remoteBranch}`,
    localCommit: local.out,
  };
}

function remoteCommit(state: GitState): string {
  const remote = run(
    "git",
    ["ls-remote", "--exit-code", state.remote, state.mergeRef],
    { capture: true },
  );
  if (!remote.ok || !remote.out) {
    log.error("无法读取远端分支，检查网络或 upstream 配置。");
    process.exit(1);
  }
  return remote.out.split(/\s+/)[0] ?? "";
}

function valueAtPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (!isPlainObject(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function fillMissingPath(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
): boolean {
  const sourceValue = valueAtPath(source, path);
  if (sourceValue === undefined) return false;

  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (next === undefined) {
      cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
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

function syncSettingFields(): void {
  const example = JSON.parse(
    readFileSync(join(repoDir, "data", "setting.example.json"), "utf-8"),
  );
  const current = JSON.parse(readFileSync(settingPath, "utf-8"));

  const added: string[] = [];
  for (const path of AUTO_SYNC_SETTING_PATHS) {
    if (fillMissingPath(current, example, path)) added.push(path);
  }

  if (added.length === 0) {
    log.info("setting.json 无需补全字段。");
    return;
  }
  writeFileSync(settingPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  log.info(`已为 setting.json 补全 ${added.length} 个字段：`);
  for (const path of added) log.info(`  + ${path}`);
}

export function runUpdate(opts: { check: boolean }): void {
  if (isDevMode) {
    log.error("dev 模式不支持 update，请直接用 git/pnpm 操作仓库。");
    process.exit(1);
  }
  ensureGitWorktree();
  const git = loadGitState();

  if (opts.check) {
    const remoteHead = remoteCommit(git);
    log.info(
      remoteHead === git.localCommit
        ? "已是最新"
        : "远端有新提交可更新（运行 update 应用）",
    );
    return;
  }

  if (!run("git", ["fetch", "--quiet", git.remote]).ok) {
    log.error("git fetch 失败，检查网络或远程配置。");
    process.exit(1);
  }

  const counts = run(
    "git",
    ["rev-list", "--count", `HEAD..${git.upstream}`],
    { capture: true },
  );
  if (!counts.ok) {
    log.error("无法比较远程分支，可能未配置 upstream。");
    process.exit(1);
  }
  const behind = Number(counts.out);
  if (behind === 0) {
    log.info("已是最新，无需更新。");
    return;
  }

  const dirty = run("git", ["status", "--porcelain"], { capture: true });
  if (dirty.out.length > 0) {
    log.error("工作树有未提交改动，update 已中止。请先处理：");
    log.error(dirty.out);
    process.exit(1);
  }

  const wasRunning = isDaemonRunning();
  const oldCommit = git.localCommit;
  const oldVersion = loadAppVersion();

  // ── 以下旧 daemon 继续服务，任一步失败即停、保留现场 ──
  log.info(`更新中：落后 ${behind} 个提交，拉取 ${git.branch}…`);
  if (!run("git", ["pull", "--ff-only"]).ok) {
    log.error("git pull 失败（可能非 fast-forward），update 中止，daemon 未受影响。");
    process.exit(1);
  }

  const changed = run("git", ["diff", "--name-only", oldCommit, "HEAD"], { capture: true });
  if (changed.out.split("\n").includes("pnpm-lock.yaml")) {
    log.info("依赖有变化，pnpm install…");
    if (!run("pnpm", ["install", "--frozen-lockfile"]).ok) {
      log.error("pnpm install 失败，update 中止，daemon 未受影响。修复后重试。");
      process.exit(1);
    }
  }

  log.info("pnpm build…");
  if (!run("pnpm", ["build"]).ok) {
    log.error("pnpm build 失败，update 中止，daemon 未受影响。修复后重试。");
    process.exit(1);
  }

  syncSettingFields();

  const newVersion = loadAppVersion();

  if (wasRunning) {
    log.info("重启 daemon…");
    stopDaemon();
    startDaemon();
  } else {
    log.info("daemon 原本未运行，仅更新代码，未启动。");
  }

  log.info(`更新完成：${oldVersion} → ${newVersion}`);
}
