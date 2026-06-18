import { Cron } from "croner";
import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import type { HarnessManager } from "../agent/harness.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { DiaryService } from "../diary/service.js";
import { runConsolidation } from "../memory/consolidation.js";
import { logger } from "../log.js";

const log = logger("cron");

export function initSchedules(
  db: Database.Database,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  registry: ChatRegistry,
): Cron[] {
  const jobs: Cron[] = [];

  // 周日 23:55 —— 周度总结 + 合并
  jobs.push(
    new Cron("55 23 * * 0", { timezone: "Asia/Shanghai" }, async () => {
      log.info("触发周度合并");
      try {
        await runConsolidation(db, harnessManager, channel, registry);
      } catch (err) {
        log.error("周度合并失败:", err);
      }
    }),
  );

  // 每天 21:00 —— 检查是否需要提醒记日记
  jobs.push(
    new Cron("0 21 * * *", { timezone: "Asia/Shanghai" }, async () => {
      log.info("检查日记提醒");
      try {
        await checkDiaryReminder(db, channel, registry);
      } catch (err) {
        log.error("日记提醒失败:", err);
      }
    }),
  );

  log.info("已注册 2 个定时任务（周总结 周日23:55 / 日记提醒 每天21:00）");
  return jobs;
}

async function checkDiaryReminder(
  db: Database.Database,
  channel: LarkChannel,
  registry: ChatRegistry,
): Promise<void> {
  const diaryService = new DiaryService(db);
  const lastTime = diaryService.getLastEntryTime();

  if (!lastTime) {
    await sendReminder(channel, registry, "你还没有开始记日记哦，今天试试？");
    return;
  }

  const daysSince = Math.floor(
    (Date.now() - new Date(lastTime).getTime()) / 86_400_000,
  );

  if (daysSince >= 3) {
    await sendReminder(
      channel,
      registry,
      `已经 ${daysSince} 天没记日记了，随便说说最近在想什么？`,
    );
  }
}

async function sendReminder(
  channel: LarkChannel,
  registry: ChatRegistry,
  text: string,
): Promise<void> {
  const diaryChats = registry.getDiaryChats();
  for (const chatId of diaryChats) {
    await channel.send(chatId, { text: `📝 ${text}` });
  }
}
