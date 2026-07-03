import { Cron } from "croner";
import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync } from "node:fs";
import {
  basename,
  isAbsolute,
  relative,
  resolve as resolvePath,
} from "node:path";
import type { AgentService } from "../agent/index.js";
import type { WeeklyReviewInput } from "../agent/agents/weekly-review.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { runConsolidation } from "../memory/consolidation.js";
import { runDailyMemory } from "../memory/daily-memory.js";
import { logger } from "../log.js";
import {
  loadSchedulesConfig,
  type AgentSchedule,
  type ScheduleDefinition,
  type ScriptSchedule,
} from "./config.js";
import { MessageService } from "../storage/messages.js";
import { scriptDir, type ScriptRuntimeConfig, type SettingConfig } from "../config.js";
import { VaultService, type VaultFile } from "../knowledge/vault.js";
import { isoWeekKey, isoWeekRange } from "../utils.js";
import { larkChatConversationId, larkMessageId } from "../lark/ingest.js";
import { createTopicChat } from "../lark/commands.js";
import { renderInfoCard, renderKnowledgeCard } from "../lark/cards.js";
import { buildScheduleScriptContext } from "./context.js";

const log = logger("cron");

type ScheduleResult =
  | null
  | undefined
  | string
  | {
    title?: string;
    body: string;
    domain?: string;
    tags?: string[];
    brief?: string;
    source_url?: string;
  };

interface NormalizedScheduleResult {
  title: string;
  body: string;
  domain?: string;
  tags: string[];
  brief?: string;
  source_url?: string;
}

interface AgentTaskSpec {
  system?: "bare" | "mori" | string;
  prompt: string;
  tools?: Array<string | AgentTool<any>>;
  result?: (ctx: { text: string }) => ScheduleResult | Promise<ScheduleResult>;
}

export function initSchedules(
  db: Database.Database,
  channel: LarkChannel,
  agentService: AgentService,
  registry: ChatRegistry,
  setting: SettingConfig,
): Cron[] {
  const jobs: Cron[] = [];
  const config = loadSchedulesConfig();
  const timezone = setting.time.timezone;

  for (const schedule of config.schedules) {
    if (schedule.kind === "builtin" && schedule.cron) {
      jobs.push(
        new Cron(schedule.cron, { timezone }, async () => {
          if (!isScheduleEnabled(schedule.id)) {
            log.info(`跳过已停用 builtin: ${schedule.id}`);
            return;
          }
          const current = getCurrentSchedule(schedule.id);
          if (!current || current.kind !== "builtin") return;
          log.info(`触发 builtin: ${schedule.id}`);
          try {
            await runBuiltin(current, db, channel, agentService, registry);
          } catch (err) {
            log.error(`${current.builtin} 失败:`, err);
          }
        }),
      );
    }

    if (schedule.kind === "script") {
      jobs.push(
        new Cron(schedule.cron, { timezone }, async () => {
          if (!isScheduleEnabled(schedule.id)) {
            log.info(`跳过已停用 script: ${schedule.id}`);
            return;
          }
          const current = getCurrentSchedule(schedule.id);
          if (!current || current.kind !== "script") return;
          log.info(`触发 script: ${schedule.id}`);
          try {
            await runScriptSchedule(
              current,
              channel,
              registry,
              db,
              setting.script.defaults,
              timezone,
            );
          } catch (err) {
            log.error(`script ${schedule.id} 失败:`, err);
          }
        }),
      );
    }

    if (schedule.kind === "agent") {
      jobs.push(
        new Cron(schedule.cron, { timezone }, async () => {
          if (!isScheduleEnabled(schedule.id)) {
            log.info(`跳过已停用 agent: ${schedule.id}`);
            return;
          }
          const current = getCurrentSchedule(schedule.id);
          if (!current || current.kind !== "agent") return;
          log.info(`触发 agent: ${schedule.id}`);
          try {
            await runAgentSchedule(
              current,
              channel,
              registry,
              db,
              agentService,
              setting.script.defaults,
              timezone,
            );
          } catch (err) {
            log.error(`agent ${schedule.id} 失败:`, err);
          }
        }),
      );
    }
  }

  log.info(`已注册 ${jobs.length} 个 cron 定时任务`);
  return jobs;
}

export async function runScheduleNow(
  scheduleId: string,
  db: Database.Database,
  channel: LarkChannel,
  agentService: AgentService,
  registry: ChatRegistry,
  setting: SettingConfig,
): Promise<void> {
  const schedule = getCurrentSchedule(scheduleId);
  if (!schedule) {
    throw new Error(`定时任务不存在：${scheduleId}`);
  }

  log.info(`手动触发定时任务: ${schedule.id}`);
  if (schedule.kind === "builtin") {
    await runBuiltin(schedule, db, channel, agentService, registry);
    return;
  }

  if (schedule.kind === "script") {
    await runScriptSchedule(
      schedule,
      channel,
      registry,
      db,
      setting.script.defaults,
      setting.time.timezone,
    );
    return;
  }

  await runAgentSchedule(
    schedule,
    channel,
    registry,
    db,
    agentService,
    setting.script.defaults,
    setting.time.timezone,
  );
}

async function runBuiltin(
  schedule: ScheduleDefinition,
  db: Database.Database,
  channel: LarkChannel,
  agentService: AgentService,
  registry: ChatRegistry,
): Promise<void> {
  if (schedule.kind !== "builtin") return;
  if (schedule.builtin === "weekly_summary") {
    await runConsolidation(db, agentService, channel, registry);
  } else if (schedule.builtin === "daily_memory") {
    await runDailyMemory(db, agentService, channel, registry);
  } else if (schedule.builtin === "weekly_review") {
    await runWeeklyReview(db, agentService, channel, registry);
  }
}

async function runScriptSchedule(
  schedule: ScriptSchedule,
  channel: LarkChannel,
  registry: ChatRegistry,
  db: Database.Database,
  scriptDefaults: ScriptRuntimeConfig,
  timezone: string,
): Promise<void> {
  const scriptPath = resolveScriptPath(schedule.script);
  const result = await runUserScript(
    schedule,
    scriptPath,
    mergeScriptRuntime(scriptDefaults, schedule.runtime),
    timezone,
  );
  await deliverScheduleResult(schedule, result, channel, registry, db);
}

async function runAgentSchedule(
  schedule: AgentSchedule,
  channel: LarkChannel,
  registry: ChatRegistry,
  db: Database.Database,
  agentService: AgentService,
  scriptDefaults: ScriptRuntimeConfig,
  timezone: string,
): Promise<void> {
  const runtime = mergeScriptRuntime(scriptDefaults, schedule.runtime);
  const result = await withTimeout(
    runAgentScheduleInner(schedule, agentService, timezone),
    runtime.timeoutMs,
    `agent 超时：${schedule.id}`,
  );
  await deliverScheduleResult(schedule, result, channel, registry, db);
}

async function runAgentScheduleInner(
  schedule: AgentSchedule,
  agentService: AgentService,
  timezone: string,
): Promise<ScheduleResult> {
  if (schedule.prompt && schedule.script) {
    throw new Error(`agent ${schedule.id} 不能同时配置 prompt 和 script`);
  }
  if (schedule.prompt) {
    const text = await agentService.runTask(schedule.prompt, {
      profile: schedule.profile,
      system: schedule.system ?? "bare",
      tools: schedule.tools ?? [],
    });
    return { title: schedule.name, body: text };
  }
  if (schedule.script) {
    const task = await loadAgentTask(schedule, timezone);
    if (task === null) return null;
    const text = await agentService.runTask(task.prompt, {
      profile: schedule.profile,
      system: task.system ?? "bare",
      tools: task.tools ?? [],
    });
    return task.result ? await task.result({ text }) : { body: text };
  }
  throw new Error(`agent ${schedule.id} 必须配置 prompt 或 script`);
}

async function loadAgentTask(
  schedule: AgentSchedule,
  timezone: string,
): Promise<AgentTaskSpec | null> {
  const scriptPath = resolveScriptPath(schedule.script!);
  const mod = await import(`${pathToFileURL(scriptPath).href}?t=${Date.now()}`);
  if (typeof mod.default !== "function") {
    throw new Error("agent script 必须 default export 一个 async function");
  }
  const value = await mod.default({
    Type,
    ...buildScheduleScriptContext({
      scheduleId: schedule.id,
      context: schedule.context,
      timezone,
    }),
  });
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    throw new Error("agent script 必须返回 task spec 或 null");
  }
  const task = value as Partial<AgentTaskSpec>;
  if (typeof task.prompt !== "string" || !task.prompt.trim()) {
    throw new Error("agent script 返回缺少 prompt");
  }
  if (task.tools !== undefined && !Array.isArray(task.tools)) {
    throw new Error("agent script 返回 tools 必须是数组");
  }
  if (task.result !== undefined && typeof task.result !== "function") {
    throw new Error("agent script 返回 result 必须是函数");
  }
  return task as AgentTaskSpec;
}

async function deliverScheduleResult(
  schedule: ScriptSchedule | AgentSchedule,
  value: ScheduleResult,
  channel: LarkChannel,
  registry: ChatRegistry,
  db: Database.Database,
): Promise<void> {
  const output = normalizeScheduleResult(schedule.name, value);
  if (!output) {
    log.info(`${schedule.kind} ${schedule.id} 本窗口无投递，跳过`);
    return;
  }

  const shouldNotify = schedule.deliver?.notify === true;
  if (!shouldNotify) {
    log.info(`${schedule.kind} ${schedule.id} 已运行，无投递目标`);
    return;
  }

  const chatId = await ensureNotificationChat(
    channel,
    registry,
    schedule.deliver?.notifyChat?.trim() || undefined,
  );
  const sent = await channel.send(chatId, {
    card: renderInfoCard(output.title, output.body),
  });
  new MessageService(db).saveAssistantMessage({
    id: larkMessageId(sent.messageId)!,
    source: "lark",
    conversationId: larkChatConversationId(chatId),
    conversationType: "notification",
    content: output.body,
  });
}

export function deterministicSlug(scheduleId: string, window: string): string {
  return `${scheduleId}-${window}`.replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-");
}

export function resolveScriptPath(script: string): string {
  if (!script.endsWith(".mjs")) {
    throw new Error("script 只支持 .mjs");
  }
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  const root = resolvePath(scriptDir);
  const abs = resolvePath(root, script);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`script 路径越界：${script}`);
  }
  if (!existsSync(abs)) throw new Error(`script 不存在：${abs}`);
  return abs;
}

export function isScheduleEnabled(scheduleId: string): boolean {
  return getCurrentSchedule(scheduleId)?.enabled ?? false;
}

function getCurrentSchedule(scheduleId: string): ScheduleDefinition | undefined {
  return loadSchedulesConfig().schedules.find((schedule) => schedule.id === scheduleId);
}

function runUserScript(
  schedule: ScriptSchedule,
  scriptPath: string,
  runtime: ScriptRuntimeConfig,
  timezone: string,
): Promise<ScheduleResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./script-worker.js", import.meta.url), {
      workerData: {
        scriptPath,
        scheduleId: schedule.id,
        context: schedule.context,
        timezone,
      },
      resourceLimits: runtime.resourceLimits,
    });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => { });
      reject(new Error(`script 超时：${basename(scriptPath)}`));
    }, runtime.timeoutMs);

    worker.once("message", (message: unknown) => {
      clearTimeout(timer);
      const result = message as { ok: boolean; result?: unknown; error?: string };
      if (!result.ok) {
        reject(new Error(result.error ?? "script 执行失败"));
        return;
      }
      try {
        resolve(result.result as ScheduleResult);
      } catch (err) {
        reject(err);
      }
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`script worker 退出码 ${code}`));
      }
    });
  });
}

function mergeScriptRuntime(
  defaults: ScriptRuntimeConfig,
  override?: Partial<ScriptRuntimeConfig>,
): ScriptRuntimeConfig {
  return {
    timeoutMs: override?.timeoutMs ?? defaults.timeoutMs,
    resourceLimits: {
      ...defaults.resourceLimits,
      ...override?.resourceLimits,
    },
  };
}

function normalizeScheduleResult(
  fallbackTitle: string,
  value: ScheduleResult,
): NormalizedScheduleResult | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (!value.trim()) throw new Error("schedule 返回 body 不能为空");
    return { title: fallbackTitle, body: value, tags: [] };
  }
  if (typeof value !== "object") {
    throw new Error("schedule 返回值必须是字符串、对象或 null");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.body !== "string" || !record.body.trim()) {
    throw new Error("schedule 返回缺少 body");
  }
  if (record.tags !== undefined && !Array.isArray(record.tags)) {
    throw new Error("schedule 返回 tags 必须是数组");
  }
  return {
    title: typeof record.title === "string" && record.title.trim()
      ? record.title
      : fallbackTitle,
    body: record.body,
    domain: typeof record.domain === "string" ? record.domain : undefined,
    tags: (record.tags as string[] | undefined) ?? [],
    brief: typeof record.brief === "string" ? record.brief : undefined,
    source_url: typeof record.source_url === "string"
      ? record.source_url
      : undefined,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const DEFAULT_NOTIFY_CHAT_NAME = "mori 通知";

async function runWeeklyReview(
  db: Database.Database,
  agentService: AgentService,
  channel: LarkChannel,
  registry: ChatRegistry,
): Promise<void> {
  const vault = agentService.getVaultService();
  const files = vault.listFrontmatter();
  const missing = missingReviewPeriods(files, new Date()).slice(0, 4);
  if (missing.length === 0) {
    log.info("收藏周报无缺口，跳过");
    return;
  }

  const generated: Array<{ period: string; path: string; body: string; titles: string[] }> = [];
  for (const period of missing) {
    const weekItems = weekItemsForPeriod(vault, files, period);
    if (weekItems.length === 0) continue;
    const input: WeeklyReviewInput = {
      weekItems,
      priorReviews: priorReviewsForPeriod(vault, files, period),
      period,
    };
    const body = await agentService.runWeeklyReviewBuiltin(input);
    if (!body) {
      log.warn(`收藏周报 ${period} 未返回正文，留待下次重试`);
      continue;
    }
    const result = vault.ingestNote({
      title: `${period} 收藏周报`,
      body,
      source_type: "review",
      path: `reviews/${period}.md`,
      period,
      covers: weekItems.map((item) => item.path),
    });
    generated.push({
      period,
      path: result.path,
      body,
      titles: weekItems.map((item) => item.title),
    });
    files.push(vault.read(result.path));
  }

  const latest = generated.at(-1);
  if (!latest) return;
  const chatId = await ensureNotificationChat(channel, registry);
  const cardBody = `${latest.body}\n\n---\n${latest.titles.map((title) => `- ${title}`).join("\n")}`;
  const sent = await channel.send(chatId, {
    card: renderKnowledgeCard(`${latest.period} 收藏周报`, cardBody),
  });
  new MessageService(db).saveAssistantMessage({
    id: larkMessageId(sent.messageId)!,
    source: "lark",
    conversationId: larkChatConversationId(chatId),
    conversationType: "notification",
    content: cardBody,
    knowledgePath: latest.path,
  });
}

function missingReviewPeriods(files: VaultFile[], now: Date): string[] {
  const nowMs = now.getTime();
  const existing = new Set(
    files
      .filter((file) => file.frontmatter.source_type === "review")
      .map((file) => String(file.frontmatter.period || "").trim())
      .filter(Boolean),
  );
  const periods = new Set<string>();
  for (const file of files) {
    if (file.frontmatter.source_type === "review") continue;
    const savedAt = Date.parse(String(file.frontmatter.saved_at ?? ""));
    if (!Number.isFinite(savedAt)) continue;
    const period = isoWeekKey(new Date(savedAt));
    if (Date.parse(isoWeekRange(period).endIso) > nowMs) continue;
    periods.add(period);
  }
  return [...periods]
    .filter((period) => !existing.has(period))
    .sort();
}

function weekItemsForPeriod(
  vault: VaultService,
  files: VaultFile[],
  period: string,
): WeeklyReviewInput["weekItems"] {
  const range = isoWeekRange(period);
  const start = Date.parse(range.startIso);
  const end = Date.parse(range.endIso);
  return files
    .filter((file) => file.frontmatter.source_type !== "review")
    .filter((file) => {
      const savedAt = Date.parse(String(file.frontmatter.saved_at ?? ""));
      return Number.isFinite(savedAt) && savedAt >= start && savedAt < end;
    })
    .sort((a, b) =>
      String(a.frontmatter.saved_at ?? "").localeCompare(
        String(b.frontmatter.saved_at ?? ""),
      ),
    )
    .map((file) => {
      const full = vault.read(file.path);
      return {
        path: full.path,
        title: String(full.frontmatter.title ?? full.path),
        source_type: String(full.frontmatter.source_type ?? ""),
        excerpt: excerpt(full.body, 500),
      };
    });
}

function priorReviewsForPeriod(
  vault: VaultService,
  files: VaultFile[],
  period: string,
): WeeklyReviewInput["priorReviews"] {
  return files
    .filter((file) => file.frontmatter.source_type === "review")
    .filter((file) => String(file.frontmatter.period ?? "") < period)
    .sort((a, b) =>
      String(b.frontmatter.period ?? "").localeCompare(
        String(a.frontmatter.period ?? ""),
      ),
    )
    .slice(0, 2)
    .map((file) => {
      const full = vault.read(file.path);
      return {
        period: String(full.frontmatter.period ?? file.path),
        body: full.body,
      };
    });
}

function excerpt(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

async function ensureNotificationChat(
  channel: LarkChannel,
  registry: ChatRegistry,
  name?: string,
): Promise<string> {
  // 配了群名：按名字找命名通知群，没有就新建（非默认）。
  if (name) {
    const existing = registry.findNotificationChatByName(name);
    if (existing) return existing;
    return createNotificationChat(channel, registry, name, false);
  }

  // 默认群：按 isDefault 标记识别（群名可被改，不能靠名字）。
  const def = registry.getDefaultNotificationChat();
  if (def) return def;
  // 迁移：旧部署的默认群只有名字没有标记，补上标记复用，避免重复建群。
  const legacy = registry.findNotificationChatByName(DEFAULT_NOTIFY_CHAT_NAME);
  if (legacy) {
    registry.register(legacy, "notification", DEFAULT_NOTIFY_CHAT_NAME, true);
    return legacy;
  }
  return createNotificationChat(channel, registry, DEFAULT_NOTIFY_CHAT_NAME, true);
}

async function createNotificationChat(
  channel: LarkChannel,
  registry: ChatRegistry,
  name: string,
  isDefault: boolean,
): Promise<string> {
  const ownerOpenId = registry.getOwnerOpenId();
  if (!ownerOpenId) {
    throw new Error("无法创建通知群：ownerOpenId 未绑定");
  }
  const { chatId } = await createTopicChat(channel, {
    name,
    description: "mori 定时投喂通知话题群",
    ownerOpenId,
  });
  registry.register(chatId, "notification", name, isDefault);
  return chatId;
}
