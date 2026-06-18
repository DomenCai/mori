// 极简结构化日志：时间戳 + level + scope。输出到 stdout/stderr，
// 后台运行时由 `personal-agent start` 把这两个流重定向到 logs/agent.log。
// 不引入第三方日志库，也不自己管文件句柄——落盘是守护进程的职责。

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[process.env.LOG_LEVEL as Level] ?? LEVELS.info;

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const prefix = `${timestamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
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
