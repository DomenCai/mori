import { randomBytes } from "node:crypto";

export function genId(prefix = ""): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return prefix ? `${prefix}_${ts}_${rand}` : `${ts}_${rand}`;
}

export function nowISO(): string {
  return new Date().toISOString();
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
