import { Cron } from "croner";
import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from "node:path";
import type { HarnessManager } from "../agent/harness.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { runConsolidation } from "../memory/consolidation.js";
import { runDailyMemory } from "../memory/daily-memory.js";
import { logger } from "../log.js";
import {
  loadSchedulesConfig,
  type AgentSchedule,
  type KnowledgeIndexTrigger,
  type ScheduleDefinition,
  type ScriptSchedule,
} from "./config.js";
import { MessageService } from "../storage/messages.js";
import { scriptDir, type ScriptRuntimeConfig, type SettingConfig } from "../config.js";
import {
  slugify,
  VaultService,
  type KnowledgeArticle,
} from "../knowledge/vault.js";
import { runWindow } from "../utils.js";
import { renderInfoCard, renderKnowledgeCard } from "../lark/cards.js";
import { larkChatConversationId, larkMessageId } from "../lark/ingest.js";

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
  harnessManager: HarnessManager,
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
            await runBuiltin(current, db, channel, harnessManager, registry);
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
              harnessManager,
              setting.script.defaults,
            );
          } catch (err) {
            log.error(`agent ${schedule.id} 失败:`, err);
          }
        }),
      );
    }
  }

  const knowledgeIndex = config.schedules.find(
    (schedule) =>
      schedule.kind === "builtin" &&
      schedule.builtin === "knowledge_index",
  );
  if (knowledgeIndex?.trigger) {
    setInterval(() => {
      const current = getCurrentSchedule(knowledgeIndex.id);
      if (!current?.enabled || current.kind !== "builtin" || !current.trigger) {
        log.info(`跳过已停用 knowledge_index: ${knowledgeIndex.id}`);
        return;
      }
      runKnowledgeIndexIfNeeded(current.trigger, harnessManager).catch(
        (err) => {
          log.error("知识地图刷新失败:", err);
        },
      );
    }, setting.knowledge.index.checkIntervalMs);
    if (knowledgeIndex.enabled) {
      runKnowledgeIndexIfNeeded(knowledgeIndex.trigger, harnessManager).catch((err) => {
        log.error("知识地图刷新失败:", err);
      });
    }
  }

  log.info(`已注册 ${jobs.length} 个 cron 定时任务`);
  return jobs;
}

export async function runScheduleNow(
  scheduleId: string,
  db: Database.Database,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  registry: ChatRegistry,
  setting: SettingConfig,
): Promise<void> {
  const schedule = getCurrentSchedule(scheduleId);
  if (!schedule) {
    throw new Error(`定时任务不存在：${scheduleId}`);
  }

  log.info(`手动触发定时任务: ${schedule.id}`);
  if (schedule.kind === "builtin") {
    await runBuiltin(schedule, db, channel, harnessManager, registry);
    return;
  }

  if (schedule.kind === "script") {
    await runScriptSchedule(
      schedule,
      channel,
      registry,
      db,
      setting.script.defaults,
    );
    return;
  }

  await runAgentSchedule(
    schedule,
    channel,
    registry,
    db,
    harnessManager,
    setting.script.defaults,
  );
}

async function runBuiltin(
  schedule: ScheduleDefinition,
  db: Database.Database,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  registry: ChatRegistry,
): Promise<void> {
  if (schedule.kind !== "builtin") return;
  if (schedule.builtin === "weekly_summary") {
    await runConsolidation(db, harnessManager, channel, registry);
  } else if (schedule.builtin === "daily_memory") {
    await runDailyMemory(db, harnessManager, channel, registry);
  } else if (schedule.builtin === "knowledge_index") {
    await harnessManager.runKnowledgeIndexBuiltin();
  }
}

async function runScriptSchedule(
  schedule: ScriptSchedule,
  channel: LarkChannel,
  registry: ChatRegistry,
  db: Database.Database,
  scriptDefaults: ScriptRuntimeConfig,
): Promise<void> {
  const scriptPath = resolveScriptPath(schedule.script);
  const result = await runUserScript(
    scriptPath,
    mergeScriptRuntime(scriptDefaults, schedule.runtime),
  );
  await deliverScheduleResult(schedule, result, channel, registry, db);
}

async function runAgentSchedule(
  schedule: AgentSchedule,
  channel: LarkChannel,
  registry: ChatRegistry,
  db: Database.Database,
  harnessManager: HarnessManager,
  scriptDefaults: ScriptRuntimeConfig,
): Promise<void> {
  const runtime = mergeScriptRuntime(scriptDefaults, schedule.runtime);
  const result = await withTimeout(
    runAgentScheduleInner(schedule, harnessManager),
    runtime.timeoutMs,
    `agent 超时：${schedule.id}`,
  );
  await deliverScheduleResult(schedule, result, channel, registry, db);
}

async function runAgentScheduleInner(
  schedule: AgentSchedule,
  harnessManager: HarnessManager,
): Promise<ScheduleResult> {
  if (schedule.prompt && schedule.script) {
    throw new Error(`agent ${schedule.id} 不能同时配置 prompt 和 script`);
  }
  if (schedule.prompt) {
    if (schedule.deliver?.inbox) {
      throw new Error(`agent inline prompt 不允许写入 Inbox：${schedule.id}`);
    }
    const text = await harnessManager.runTask(schedule.prompt, {
      system: schedule.system ?? "bare",
      tools: schedule.tools ?? [],
    });
    return { title: schedule.name, body: text };
  }
  if (schedule.script) {
    const task = await loadAgentTask(schedule.script);
    if (task === null) return null;
    const text = await harnessManager.runTask(task.prompt, {
      system: task.system ?? "bare",
      tools: task.tools ?? [],
    });
    return task.result ? await task.result({ text }) : { body: text };
  }
  throw new Error(`agent ${schedule.id} 必须配置 prompt 或 script`);
}

async function loadAgentTask(script: string): Promise<AgentTaskSpec | null> {
  const scriptPath = resolveScriptPath(script);
  const mod = await import(`${pathToFileURL(scriptPath).href}?t=${Date.now()}`);
  if (typeof mod.default !== "function") {
    throw new Error("agent script 必须 default export 一个 async function");
  }
  const value = await mod.default({ Type });
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
  const inbox = schedule.deliver?.inbox?.trim();
  if (!inbox && !shouldNotify) {
    log.info(`${schedule.kind} ${schedule.id} 已运行，无投递目标`);
    return;
  }

  let knowledgePath: string | null = null;
  if (inbox) {
    const vault = new VaultService();
    const slug = deterministicSlug(schedule.id, runWindow(new Date()));
    const article = toKnowledgeArticle(output);
    const writeResult = vault.writeInbox(inbox, slug, article);
    if (writeResult.existed) {
      log.info(`${schedule.kind} ${schedule.id} 本窗口已投递，跳过: ${writeResult.path}`);
      return;
    }
    knowledgePath = writeResult.path;
  }

  if (!shouldNotify) return;
  const chatId = await ensureNotificationChat(channel, registry);
  const sent = await channel.send(chatId, {
    card: knowledgePath
      ? renderKnowledgeCard(output.title, output.body)
      : renderInfoCard(output.title, output.body),
  });
  if (knowledgePath) {
    new VaultService().updateFrontmatter(knowledgePath, {
      pushed_message_id: sent.messageId,
    });
  }
  new MessageService(db).saveAssistantMessage({
    id: larkMessageId(sent.messageId)!,
    source: "lark",
    conversationId: larkChatConversationId(chatId),
    conversationType: "notification",
    content: output.body,
    knowledgePath,
  });
}

export function deterministicSlug(scheduleId: string, window: string): string {
  return slugify(`${scheduleId}-${window}`);
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
  scriptPath: string,
  runtime: ScriptRuntimeConfig,
): Promise<ScheduleResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./script-worker.js", import.meta.url), {
      workerData: { scriptPath },
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

function toKnowledgeArticle(output: NormalizedScheduleResult): KnowledgeArticle {
  if (!output.title || !output.domain || !output.brief || !output.body) {
    throw new Error("写入 Inbox 需要返回完整文章字段：title/domain/brief/body");
  }
  return {
    title: output.title,
    domain: output.domain,
    tags: output.tags,
    brief: output.brief,
    body: output.body,
    source_url: output.source_url,
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

async function ensureNotificationChat(
  channel: LarkChannel,
  registry: ChatRegistry,
): Promise<string> {
  const existing = registry.getNotificationChats()[0];
  if (existing) return existing;

  const ownerOpenId = registry.getOwnerOpenId();
  if (!ownerOpenId) {
    throw new Error("无法创建通知群：ownerOpenId 未绑定");
  }
  const { chatId } = await channel.createChat({
    name: "mori 通知",
    description: "mori 定时投喂通知群",
    inviteUserIds: [ownerOpenId],
    userIdType: "open_id",
  });
  registry.register(chatId, "notification", "mori 通知");
  return chatId;
}

async function runKnowledgeIndexIfNeeded(
  trigger: KnowledgeIndexTrigger,
  harnessManager: HarnessManager,
): Promise<void> {
  if (shouldRunKnowledgeIndex(trigger)) {
    await harnessManager.runKnowledgeIndexBuiltin();
  }
}

function shouldRunKnowledgeIndex(trigger: KnowledgeIndexTrigger): boolean {
  const vault = new VaultService();
  vault.ensureBaseDirs();
  const indexPath = vault.resolve(".index.md");
  const files = listMarkdownFiles(vault.resolve("."));
  const knowledgeFiles = files.filter((file) => basename(file) !== ".index.md");
  if (knowledgeFiles.length === 0) return false;
  if (!existsSync(indexPath)) return true;

  const indexMtime = statSync(indexPath).mtimeMs;
  const newCount = knowledgeFiles.filter((file) => statSync(file).mtimeMs > indexMtime).length;
  const ageDays = (Date.now() - indexMtime) / 86_400_000;
  return newCount >= trigger.n || (newCount > 0 && ageDays > trigger.days);
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return extname(root) === ".md" ? [root] : [];
  return readdirSync(root).flatMap((name) => listMarkdownFiles(join(root, name)));
}
