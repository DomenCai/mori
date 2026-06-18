// 后台守护进程生命周期：start / stop / status。
// start：detached 子进程跑 `run`，自身按天写 logs/YYYY-MM-DD.log。
// pid 文件记录启动时间和脚本路径，stop/status 先校验进程归属，避免 PID 复用误杀。
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { loadLarkConfig, logsDir, pidPath } from "./config.js";
import { dailyLogPath, logger } from "./log.js";

const bootLog = logger("boot");

interface PidRecord {
  version: 1;
  pid: number;
  scriptPath: string;
  startedAt: string;
}

interface LegacyPidRecord {
  legacy: true;
  pid: number;
}

type StoredPidRecord = PidRecord | LegacyPidRecord;

type DaemonState =
  | { kind: "none" }
  | { kind: "running"; record: PidRecord }
  | { kind: "stale"; record: StoredPidRecord | null }
  | { kind: "unverified"; pid: number; reason: string };

function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function readPidRecord(): StoredPidRecord | null {
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, "utf-8").trim();
  const legacyPid = Number(raw);
  if (/^\d+$/.test(raw) && isValidPid(legacyPid)) {
    return { legacy: true, pid: legacyPid };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PidRecord>;
    if (
      parsed.version === 1 &&
      isValidPid(parsed.pid) &&
      typeof parsed.scriptPath === "string" &&
      parsed.scriptPath.length > 0 &&
      typeof parsed.startedAt === "string" &&
      parsed.startedAt.length > 0
    ) {
      return {
        version: 1,
        pid: parsed.pid,
        scriptPath: parsed.scriptPath,
        startedAt: parsed.startedAt,
      };
    }
  } catch {
    // Malformed pid files are treated as stale runtime state.
  }
  return null;
}

function isAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessField(pid: number, field: "args" | "lstart"): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function verifyManagedProcess(record: PidRecord): "owned" | "other" | "unknown" {
  const startedAt = readProcessField(record.pid, "lstart");
  const command = readProcessField(record.pid, "args");
  if (!startedAt || !command) return "unknown";
  if (
    startedAt === record.startedAt &&
    command.includes(record.scriptPath) &&
    /(?:^|\s)run(?:\s|$)/.test(command)
  ) {
    return "owned";
  }
  return "other";
}

function readDaemonState(): DaemonState {
  if (!existsSync(pidPath)) return { kind: "none" };

  const record = readPidRecord();
  if (!record) return { kind: "stale", record: null };
  if (!isAlive(record.pid)) return { kind: "stale", record };
  if ("legacy" in record) {
    return {
      kind: "unverified",
      pid: record.pid,
      reason: "pid 文件为旧格式，缺少进程归属校验信息",
    };
  }

  const verdict = verifyManagedProcess(record);
  if (verdict === "owned") return { kind: "running", record };
  if (verdict === "other") return { kind: "stale", record };
  return {
    kind: "unverified",
    pid: record.pid,
    reason: "无法读取进程命令或启动时间，不能安全确认归属",
  };
}

function removePidFile(): void {
  if (existsSync(pidPath)) unlinkSync(pidPath);
}

function writePidRecord(pid: number): boolean {
  const scriptPath = process.argv[1];
  const startedAt = readProcessField(pid, "lstart");
  if (!scriptPath || !startedAt) return false;

  const record: PidRecord = {
    version: 1,
    pid,
    scriptPath,
    startedAt,
  };
  writeFileSync(pidPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return true;
}

export function startDaemon(): void {
  const state = readDaemonState();
  if (state.kind === "running") {
    bootLog.error(`已在运行 (pid ${state.record.pid})`);
    process.exit(1);
  }
  if (state.kind === "unverified") {
    bootLog.error(`${state.reason}，请先手动检查 pid ${state.pid}`);
    process.exit(1);
  }
  if (state.kind === "stale") removePidFile();

  if (!loadLarkConfig()) {
    bootLog.error(
      "尚未完成飞书配置，请先前台运行 `personal-agent run` 扫码注册，再用 start。",
    );
    process.exit(1);
  }

  mkdirSync(logsDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [process.argv[1], "run"],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );

  if (!child.pid || !writePidRecord(child.pid)) {
    child.kill("SIGTERM");
    bootLog.error("启动失败：无法校验后台进程信息");
    process.exit(1);
  }
  child.unref();
  bootLog.info(`已启动 (pid ${child.pid})，日志: ${dailyLogPath(logsDir)}`);
}

export function stopDaemon(): void {
  const state = readDaemonState();
  if (state.kind === "none" || state.kind === "stale") {
    bootLog.info("未在运行");
    if (state.kind === "stale") removePidFile();
    return;
  }
  if (state.kind === "unverified") {
    bootLog.error(`${state.reason}，拒绝自动停止 pid ${state.pid}`);
    process.exit(1);
  }

  process.kill(state.record.pid, "SIGTERM");
  removePidFile();
  bootLog.info(`已停止 (pid ${state.record.pid})`);
}

export function showStatus(): void {
  const state = readDaemonState();
  if (state.kind === "running") {
    bootLog.info(`运行中 (pid ${state.record.pid})，日志: ${dailyLogPath(logsDir)}`);
    return;
  }
  if (state.kind === "unverified") {
    bootLog.warn(`${state.reason}，pid=${state.pid}`);
    return;
  }
  if (state.kind === "stale") removePidFile();
  bootLog.info("未运行");
}
