import { randomBytes } from "node:crypto";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function genId(prefix = ""): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return prefix ? `${prefix}_${ts}_${rand}` : `${ts}_${rand}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

function shanghaiParts(date: Date): Record<string, string> {
  return Object.fromEntries(
    SHANGHAI_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function shanghaiDateKey(date = new Date()): string {
  const parts = shanghaiParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shanghaiFileTimestamp(date = new Date()): string {
  const parts = shanghaiParts(date);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}-${ms}+08-00`;
}

// 日志时间戳：上海时区 MM-DD HH:MM:SS.mmm
export function logTimestamp(date = new Date()): string {
  const p = shanghaiParts(date);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${ms}`;
}

// 调度运行窗口 key：上海时区 YYYY-MM-DDTHH-MM
export function runWindow(date = new Date()): string {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}-${p.minute}`;
}

// 展示用时间：上海时区 YYYY-MM-DD HH:MM
export function shanghaiDateTime(date = new Date()): string {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// 一段文本的变更摘要：按行掐掉公共前后缀，留下真正变动的整行
// （避免在 markdown 记号中间截断出 `- **` 这类碎片）。
export function summarizeTextDelta(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  ) {
    s++;
  }
  const removed = oldLines.slice(p, oldLines.length - s).join("\n").trim();
  const added = newLines.slice(p, newLines.length - s).join("\n").trim();
  const clip = (t: string) => (t.length > 80 ? `${t.slice(0, 80)}…` : t);
  if (removed && added) return `「${clip(removed)}」→「${clip(added)}」`;
  if (added) return `＋ ${clip(added)}`;
  if (removed) return `－ ${clip(removed)}`;
  return "（无文本变化）";
}

// ISO 8601 周序号（周一起始、周四定年），基于上海日历日。
// 例：2026-01-01 是周四 → 2026-W01 起于周一 2025-12-29。
export function weekKey(date = new Date()): string {
  const p = shanghaiParts(date);
  const [y, mo, d] = [Number(p.year), Number(p.month) - 1, Number(p.day)];
  // 用 UTC 锚点仅做星期/周序号运算（不涉及真实时刻），避免夏令时偏移。
  const dow = new Date(Date.UTC(y, mo, d)).getUTCDay(); // 0=周日
  const thursday = Date.UTC(y, mo, d + 3 - ((dow + 6) % 7)); // 本周周四
  const isoYear = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
