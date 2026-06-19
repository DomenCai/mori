import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { shanghaiDateKey, logTimestamp } from "./utils.js";

// 极简结构化日志：时间戳 + level + scope。输出到 stdout/stderr。
// run/dev 模式会安装 stdout/stderr tee，按上海日期写入 logs/YYYY-MM-DD.log。

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[process.env.LOG_LEVEL as Level] ?? LEVELS.info;
let dailyFileLoggingInstalled = false;

export function dailyLogPath(logsDir: string, date = new Date()): string {
  return join(logsDir, `${shanghaiDateKey(date)}.log`);
}

export function installDailyFileLogging(logsDir: string): string {
  if (dailyFileLoggingInstalled) return dailyLogPath(logsDir);
  dailyFileLoggingInstalled = true;
  mkdirSync(logsDir, { recursive: true });

  const patch = (stream: NodeJS.WriteStream): void => {
    const originalWrite = stream.write.bind(stream) as (
      ...args: unknown[]
    ) => boolean;
    (stream as unknown as { write: NodeJS.WriteStream["write"] }).write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ) => {
      try {
        appendFileSync(
          dailyLogPath(logsDir),
          typeof chunk === "string" ? chunk : Buffer.from(chunk),
        );
      } catch {
        // 日志落盘失败不能阻断主流程；控制台仍保留原始输出。
      }

      if (typeof encoding === "function") {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk, encoding, callback);
    }) as NodeJS.WriteStream["write"];
  };

  patch(process.stdout);
  patch(process.stderr);
  return dailyLogPath(logsDir);
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const prefix = `${logTimestamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  (level === "error" || level === "warn" ? console.error : console.log)(
    prefix,
    ...args,
  );
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
  };
}
