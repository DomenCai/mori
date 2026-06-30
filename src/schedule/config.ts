import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { schedulesPath } from "../config.js";
import type { ScriptRuntimeConfig } from "../config.js";
import { logger } from "../log.js";

export interface SchedulesConfig {
  schedules: ScheduleDefinition[];
}

export type ScheduleDefinition = BuiltinSchedule | ScriptSchedule | AgentSchedule;

export interface BaseSchedule {
  id: string;
  name: string;
  enabled: boolean;
  cron?: string;
}

export interface BuiltinSchedule extends BaseSchedule {
  kind: "builtin";
  builtin: "weekly_summary" | "daily_memory" | "weekly_review";
}

export interface ScriptSchedule extends BaseSchedule {
  kind: "script";
  script: string;
  cron: string;
  runtime?: Partial<ScriptRuntimeConfig>;
  deliver?: ScheduleDeliver;
}

export interface AgentSchedule extends BaseSchedule {
  kind: "agent";
  cron: string;
  /** setting.llm.model_profiles 里的档位名；不填或无效时走 normal。 */
  profile?: string;
  prompt?: string;
  script?: string;
  system?: "bare" | "mori" | string;
  tools?: string[];
  runtime?: Partial<ScriptRuntimeConfig>;
  deliver?: ScheduleDeliver;
}

export interface ScheduleDeliver {
  notify?: boolean;
  /** 通知群名称；不填走默认通知群。配了就按名字在 notification 群里找/建。 */
  notifyChat?: string;
  inbox?: string;
}

// 内置任务基线：代码是权威。新增/下线 builtin 直接改这里，
// 现存部署无需迁移即可生效（JSON 没配就走默认，下线的 builtin 自动消失）。
const BUILTIN_DEFAULTS: BuiltinSchedule[] = [
  {
    id: "weekly-summary",
    name: "周总结",
    kind: "builtin",
    builtin: "weekly_summary",
    cron: "55 23 * * 0",
    enabled: true,
  },
  {
    id: "daily-memory",
    name: "每日记忆整理",
    kind: "builtin",
    builtin: "daily_memory",
    cron: "0 6 * * *",
    enabled: true,
  },
  {
    id: "weekly-review",
    name: "收藏周报",
    kind: "builtin",
    builtin: "weekly_review",
    cron: "0 8 * * 1",
    enabled: true,
  },
];

// schedules.json 里的条目是“覆盖”，只需带 id + 想改的字段（如只改某 builtin 的 cron）。
type ScheduleOverride = { id: string; kind?: "builtin" | "script" | "agent" } & Record<
  string,
  unknown
>;

const log = logger("schedule-config");

function readOverrides(): ScheduleOverride[] {
  if (!existsSync(schedulesPath)) return [];
  const parsed = JSON.parse(readFileSync(schedulesPath, "utf-8")) as {
    schedules?: ScheduleOverride[];
  };
  return parsed.schedules ?? [];
}

export function loadSchedulesConfig(): SchedulesConfig {
  const schedules: ScheduleDefinition[] = structuredClone(BUILTIN_DEFAULTS);

  for (const override of readOverrides()) {
    const index = schedules.findIndex((item) => item.id === override.id);
    if (index >= 0) {
      // 命中基线（或已加入的 script）：只覆盖 JSON 写了的字段，其余保留默认。
      schedules[index] = { ...schedules[index], ...override } as ScheduleDefinition;
    } else if (override.kind === "script" || override.kind === "agent") {
      // 代码不认识的用户任务：JSON 是它唯一来源，原样保留。
      schedules.push(override as unknown as ScheduleDefinition);
    }
    // 命中不到的 builtin（已被代码下线）：忽略。
  }

  return { schedules };
}

export function setScheduleEnabled(scheduleId: string, enabled: boolean): SchedulesConfig {
  const current = loadSchedulesConfig().schedules.find(
    (item) => item.id === scheduleId,
  );
  if (!current) {
    throw new Error(`定时任务不存在：${scheduleId}`);
  }

  // 只把 enabled 写进覆盖层，不动该任务其它字段、也不落盘基线默认。
  const overrides = readOverrides();
  const index = overrides.findIndex((item) => item.id === scheduleId);
  log.info(
    `设置定时任务启停 id=${scheduleId} current=${current.enabled} target=${enabled} override=${index >= 0 ? "update" : "insert"}`,
  );
  if (index >= 0) {
    overrides[index] = { ...overrides[index], enabled };
  } else {
    overrides.push({ id: scheduleId, kind: current.kind, enabled });
  }

  mkdirSync(dirname(schedulesPath), { recursive: true, mode: 0o700 });
  writeFileSync(schedulesPath, JSON.stringify({ schedules: overrides }, null, 2) + "\n", {
    mode: 0o600,
  });

  const next = loadSchedulesConfig();
  const saved = next.schedules.find((item) => item.id === scheduleId);
  log.info(`定时任务启停已写入 id=${scheduleId} saved=${saved?.enabled}`);
  return next;
}

export function toggleScheduleEnabled(scheduleId: string): SchedulesConfig {
  const current = loadSchedulesConfig().schedules.find(
    (item) => item.id === scheduleId,
  );
  if (!current) {
    throw new Error(`定时任务不存在：${scheduleId}`);
  }
  return setScheduleEnabled(scheduleId, !current.enabled);
}
