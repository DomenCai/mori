import { Cron } from "croner";
import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import { Worker } from "node:worker_threads";
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
  type KnowledgeIndexTrigger,
  type ScheduleDefinition,
  type ScriptSchedule,
} from "./config.js";
import { MessageService } from "../storage/messages.js";
import { scriptDir } from "../config.js";
import {
  slugify,
  VaultService,
  type KnowledgeArticle,
} from "../knowledge/vault.js";
import { nowISO, runWindow } from "../utils.js";
import { renderMarkdownCard } from "../lark/cards.js";

const log = logger("cron");
const SCRIPT_TIMEOUT_MS = 60_000;

export function initSchedules(
  db: Database.Database,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  registry: ChatRegistry,
): Cron[] {
  const jobs: Cron[] = [];
  const config = loadSchedulesConfig();

  for (const schedule of config.schedules) {
    if (schedule.kind === "builtin" && schedule.cron) {
      jobs.push(
        new Cron(schedule.cron, { timezone: "Asia/Shanghai" }, async () => {
          if (!isScheduleEnabled(schedule.id)) {
            log.info(`跳过已停用 builtin: ${schedule.id}`);
            return;
          }
          const current = getCurrentSchedule(schedule.id);
          if (!current || current.kind !== "builtin") return;
          log.info(`触发 builtin: ${schedule.id}`);
          await runBuiltin(current, db, channel, harnessManager, registry);
        }),
      );
    }

    if (schedule.kind === "script") {
      jobs.push(
        new Cron(schedule.cron, { timezone: "Asia/Shanghai" }, async () => {
          if (!isScheduleEnabled(schedule.id)) {
            log.info(`跳过已停用 script: ${schedule.id}`);
            return;
          }
          const current = getCurrentSchedule(schedule.id);
          if (!current || current.kind !== "script") return;
          log.info(`触发 script: ${schedule.id}`);
          try {
            await runScriptSchedule(current, channel, registry, db);
          } catch (err) {
            log.error(`script ${schedule.id} 失败:`, err);
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
    }, 60 * 60 * 1000);
    if (knowledgeIndex.enabled) {
      runKnowledgeIndexIfNeeded(knowledgeIndex.trigger, harnessManager).catch((err) => {
        log.error("知识地图刷新失败:", err);
      });
    }
  }

  log.info(`已注册 ${jobs.length} 个 cron 定时任务`);
  return jobs;
}

async function runBuiltin(
  schedule: ScheduleDefinition,
  db: Database.Database,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  registry: ChatRegistry,
): Promise<void> {
  if (schedule.kind !== "builtin") return;
  try {
    if (schedule.builtin === "weekly_summary") {
      await runConsolidation(db, harnessManager, channel, registry);
    } else if (schedule.builtin === "daily_memory") {
      await runDailyMemory(db, harnessManager, channel, registry);
    } else if (schedule.builtin === "knowledge_index") {
      await harnessManager.runKnowledgeIndexBuiltin();
    }
  } catch (err) {
    log.error(`${schedule.builtin} 失败:`, err);
  }
}

async function runScriptSchedule(
  schedule: ScriptSchedule,
  channel: LarkChannel,
  registry: ChatRegistry,
  db: Database.Database,
): Promise<void> {
  const vault = new VaultService();
  const slug = deterministicSlug(schedule.id, runWindow(new Date()));
  const scriptPath = resolveScriptPath(schedule.script);
  const article = await runUserScript(scriptPath);
  const writeResult = vault.writeInbox(schedule.deliver.inbox, slug, article);
  if (writeResult.existed) {
    log.info(`script ${schedule.id} 本窗口已投递，跳过: ${writeResult.path}`);
    return;
  }

  if (!schedule.deliver.notify) return;
  const chatId = await ensureNotificationChat(channel, registry);
  const message = renderKnowledgeNotification(article, writeResult.path);
  const sent = await channel.send(chatId, { card: renderMarkdownCard(message) });
  vault.updateFrontmatter(writeResult.path, {
    pushed_message_id: sent.messageId,
  });
  new MessageService(db).saveAssistantMessage({
    id: sent.messageId,
    chatId,
    content: message,
    knowledgePath: writeResult.path,
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

function runUserScript(scriptPath: string): Promise<KnowledgeArticle> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./script-worker.js", import.meta.url), {
      workerData: { scriptPath },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
      },
    });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error(`script 超时：${basename(scriptPath)}`));
    }, SCRIPT_TIMEOUT_MS);

    worker.once("message", (message: unknown) => {
      clearTimeout(timer);
      const result = message as { ok: boolean; result?: unknown; error?: string };
      if (!result.ok) {
        reject(new Error(result.error ?? "script 执行失败"));
        return;
      }
      try {
        resolve(validateScriptResult(result.result));
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

function validateScriptResult(value: unknown): KnowledgeArticle {
  if (!value || typeof value !== "object") {
    throw new Error("script 返回值必须是对象");
  }
  const record = value as Record<string, unknown>;
  const required = ["title", "domain", "brief", "body"];
  for (const key of required) {
    if (typeof record[key] !== "string" || !record[key]) {
      throw new Error(`script 返回缺少字段：${key}`);
    }
  }
  if (record.tags !== undefined && !Array.isArray(record.tags)) {
    throw new Error("script 返回 tags 必须是数组");
  }
  return {
    title: record.title as string,
    domain: record.domain as string,
    tags: (record.tags as string[] | undefined) ?? [],
    brief: record.brief as string,
    body: record.body as string,
    source_url: typeof record.source_url === "string"
      ? record.source_url
      : undefined,
  };
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
    name: "Personal Agent 通知",
    description: "Personal Agent 定时投喂通知群",
    inviteUserIds: [ownerOpenId],
    userIdType: "open_id",
  });
  registry.register(chatId, "notification", "Personal Agent 通知");
  return chatId;
}

function renderKnowledgeNotification(
  article: KnowledgeArticle,
  path: string,
): string {
  const tags = article.tags?.length ? `\n标签：${article.tags.join(", ")}` : "";
  return `**${article.title}**

领域：${article.domain}${tags}
路径：${path}

${article.brief}

普通回复这张卡会收藏并记录你的看法；话题回复会进入临时深聊。`;
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
