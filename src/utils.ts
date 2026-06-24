import { randomBytes } from "node:crypto";

let businessTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let businessFormatter = createBusinessFormatter(businessTimeZone);

function createBusinessFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function validateTimeZone(timeZone: string): void {
  // Intl 对 undefined 不抛错而是静默用系统时区，必须先挡掉缺失/空值，否则
  // setting.time.timezone 缺字段会悄悄回退本地时区，违背 fail-fast。
  if (typeof timeZone !== "string" || !timeZone) {
    throw new Error(`无效 timezone: ${timeZone}`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`无效 timezone: ${timeZone}`);
  }
}

export function setBusinessTimeZone(timeZone: string): void {
  validateTimeZone(timeZone);
  businessTimeZone = timeZone;
  businessFormatter = createBusinessFormatter(timeZone);
}

export function getBusinessTimeZone(): string {
  return businessTimeZone;
}

const OFFSET_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = OFFSET_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  OFFSET_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

export function genId(prefix = ""): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return prefix ? `${prefix}_${ts}_${rand}` : `${ts}_${rand}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

function dateParts(date: Date, formatter: Intl.DateTimeFormat): Record<string, string> {
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function businessParts(date: Date): Record<string, string> {
  return dateParts(date, businessFormatter);
}

export function businessDateKey(date = new Date()): string {
  const parts = businessParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = dateParts(date, offsetFormatter(timeZone));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

export function businessDateStart(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let candidate = new Date(
    localMidnightAsUtc -
      timeZoneOffsetMs(new Date(localMidnightAsUtc), businessTimeZone),
  );
  const corrected = new Date(localMidnightAsUtc - timeZoneOffsetMs(candidate, businessTimeZone));
  if (corrected.getTime() !== candidate.getTime()) candidate = corrected;
  // 已知限制：若配置时区恰在午夜发生 DST 跳变（本地 00:00 这一墙钟时刻不存在，
  // 如 America/Sao_Paulo 历史规则），起点会落到前一天 23:00。Asia/Shanghai 无 DST，
  // 常见时区也不受影响，暂不处理这一极窄边界。
  return candidate;
}

export function businessDateRange(dateKey: string): { startIso: string; endIso: string } {
  const start = businessDateStart(dateKey);
  const [year, month, day] = dateKey.split("-").map(Number);
  const nextDateKey = formatDateKeyFromUtcDate(Date.UTC(year, month - 1, day + 1));
  const end = businessDateStart(nextDateKey);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function businessDayDiff(start: Date, end: Date): number {
  return dateKeyDayIndex(businessDateKey(end)) - dateKeyDayIndex(businessDateKey(start));
}

function dateKeyDayIndex(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function formatDateKeyFromUtcDate(ms: number): string {
  const date = new Date(ms);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function previousBusinessDateKey(date = new Date()): string {
  const todayStart = businessDateStart(businessDateKey(date));
  return businessDateKey(new Date(todayStart.getTime() - 1));
}

export function businessFileTimestamp(date = new Date()): string {
  const parts = businessParts(date);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}-${ms}${formatOffsetForFilename(date)}`;
}

function formatOffsetForFilename(date: Date): string {
  const offsetMinutes = Math.round(timeZoneOffsetMs(date, businessTimeZone) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}-${minutes}`;
}

// 日志时间戳：业务时区 MM-DD HH:MM:SS.mmm
export function logTimestamp(date = new Date()): string {
  const p = businessParts(date);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${ms}`;
}

// 调度运行窗口 key：业务时区 YYYY-MM-DDTHH-MM
export function runWindow(date = new Date()): string {
  const p = businessParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}-${p.minute}`;
}

// 展示用时间：业务时区 YYYY-MM-DD HH:MM
export function businessDateTime(date = new Date()): string {
  const p = businessParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export interface TextLineChanges {
  removed: string[];
  added: string[];
}

// 按行掐掉公共前后缀，留下真正变动的整行。
export function textLineChanges(oldText: string, newText: string): TextLineChanges {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    removed: oldLines.slice(prefix, oldLines.length - suffix).filter((line) => line.trim()),
    added: newLines.slice(prefix, newLines.length - suffix).filter((line) => line.trim()),
  };
}

// ISO 8601 周序号（周一起始、周四定年），基于业务时区日历日。
// 例：2026-01-01 是周四 → 2026-W01 起于周一 2025-12-29。
export function weekKey(date = new Date()): string {
  const p = businessParts(date);
  const [y, mo, d] = [Number(p.year), Number(p.month) - 1, Number(p.day)];
  // 用 UTC 锚点仅做星期/周序号运算（不涉及真实时刻），避免夏令时偏移。
  const dow = new Date(Date.UTC(y, mo, d)).getUTCDay(); // 0=周日
  const thursday = Date.UTC(y, mo, d + 3 - ((dow + 6) % 7)); // 本周周四
  const isoYear = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
