import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { schedulesPath } from "../config.js";

export interface SchedulesConfig {
  schedules: ScheduleDefinition[];
}

export type ScheduleDefinition = BuiltinSchedule | ScriptSchedule;

export interface BaseSchedule {
  id: string;
  name: string;
  enabled: boolean;
  cron?: string;
  trigger?: KnowledgeIndexTrigger;
}

export interface BuiltinSchedule extends BaseSchedule {
  kind: "builtin";
  builtin: "weekly_summary" | "diary_reminder" | "knowledge_index";
}

export interface ScriptSchedule extends BaseSchedule {
  kind: "script";
  script: string;
  cron: string;
  deliver: {
    notify: boolean;
    inbox: string;
  };
}

export interface KnowledgeIndexTrigger {
  type: "volume";
  n: number;
  days: number;
}

const DEFAULT_CONFIG: SchedulesConfig = {
  schedules: [
    {
      id: "weekly-summary",
      name: "周总结",
      kind: "builtin",
      builtin: "weekly_summary",
      cron: "55 23 * * 0",
      enabled: true,
    },
    {
      id: "diary-reminder",
      name: "记日记提醒",
      kind: "builtin",
      builtin: "diary_reminder",
      cron: "0 21 * * *",
      enabled: true,
    },
    {
      id: "knowledge-index",
      name: "知识地图",
      kind: "builtin",
      builtin: "knowledge_index",
      trigger: { type: "volume", n: 5, days: 3 },
      enabled: true,
    },
  ],
};

export function loadSchedulesConfig(): SchedulesConfig {
  if (!existsSync(schedulesPath)) {
    saveSchedulesConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  return JSON.parse(readFileSync(schedulesPath, "utf-8")) as SchedulesConfig;
}

export function saveSchedulesConfig(config: SchedulesConfig): void {
  mkdirSync(dirname(schedulesPath), { recursive: true, mode: 0o700 });
  writeFileSync(schedulesPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function toggleScheduleEnabled(scheduleId: string): SchedulesConfig {
  const config = loadSchedulesConfig();
  const schedule = config.schedules.find((item) => item.id === scheduleId);
  if (!schedule) {
    throw new Error(`定时任务不存在：${scheduleId}`);
  }
  schedule.enabled = !schedule.enabled;
  saveSchedulesConfig(config);
  return config;
}
