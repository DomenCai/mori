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

export function weekKey(date = new Date()): string {
  const year = date.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const days = Math.floor(
    (date.getTime() - jan1.getTime()) / 86_400_000,
  );
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
