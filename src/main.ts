#!/usr/bin/env node
import { getDb, initDb, closeDb } from "./storage/db.js";
import {
  loadLarkConfig,
  saveLarkConfig,
  loadLlmConfig,
  loadSetting,
  resolveModelRoute,
  sessionsDir,
  logsDir,
  type LarkConfig,
} from "./config.js";
import { initChannel } from "./lark/channel.js";
import { runRegistrationWizard } from "./lark/setup.js";
import { ChatRegistry } from "./lark/chatRegistry.js";
import {
  handleCommand,
  renderSchedulesCard,
  type CommandContext,
} from "./lark/commands.js";
import { HarnessManager } from "./agent/harness.js";
import {
  handleChatMessage,
  handleDiaryMessage,
  handleLensMessage,
  handleNotificationMessage,
  isDiaryEntryMessage,
} from "./lark/messageHandlers.js";
import { parseLens } from "./lark/lenses.js";
import { initSchedules } from "./schedule/cron.js";
import { installDailyFileLogging, logger } from "./log.js";
import { startDaemon, stopDaemon, showStatus } from "./daemon.js";
import type { CardActionEvent, NormalizedMessage } from "@larksuite/channel";
import { toggleScheduleEnabled } from "./schedule/config.js";
import { toIngestedMessage } from "./lark/ingest.js";
import type { ConversationType } from "./ingest/message.js";

const bootLog = logger("boot");
const larkLog = logger("lark");

async function runForeground() {
  const setting = loadSetting();
  const logFile = installDailyFileLogging(logsDir);
  bootLog.info(`日志写入: ${logFile}`);

  // tee 是同步落盘，未捕获异常的栈会随默认打印进日志；这里只补两类缺口：
  // unhandledRejection（部分场景 Node 不退出，留僵尸进程）和确保以非零码退出。
  process.on("uncaughtException", (err) => {
    bootLog.error("未捕获异常，进程退出:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    bootLog.error("未处理的 Promise rejection，进程退出:", reason);
    process.exit(1);
  });

  // ── 1. 配置 & 数据库 ──
  let loaded = loadLarkConfig();
  if (!loaded) {
    loaded = await runRegistrationWizard();
    saveLarkConfig(loaded);
    bootLog.info("飞书配置已保存到 lark_config.json");
  }
  const larkConfig: LarkConfig = loaded;
  const llmConfig = loadLlmConfig();

  bootLog.info("配置加载完成");

  const companionRoute = {
    name: "companion" as const,
    ...resolveModelRoute("companion", llmConfig),
  };
  const weeklyRoute = {
    name: "weekly" as const,
    ...resolveModelRoute("weekly", llmConfig),
  };
  bootLog.info(
    `模型路由: companion → ${companionRoute.model.id}, weekly → ${weeklyRoute.model.id}`,
  );

  const db = getDb();
  initDb(db);
  bootLog.info("SQLite 初始化完成");

  // ── 2. 飞书 ──
  const channel = initChannel(larkConfig);
  const registry = new ChatRegistry(larkConfig, saveLarkConfig);

  // ── 3. Agent 管理器 ──
  const harnessManager = new HarnessManager({
    db,
    sessionsDir,
    routes: {
      companion: companionRoute,
      weekly: weeklyRoute,
    },
    channel,
    registry,
  });

  const cmdCtx: CommandContext = {
    channel,
    db,
    registry,
    harnessManager,
    ownerOpenId: larkConfig.ownerOpenId ?? "",
  };

  // ── 4. 消息处理 ──
  channel.on({
    message: async (msg: NormalizedMessage) => {
      larkLog.info(
        `收到消息 from=${msg.senderId} type=${msg.chatType} chat=${msg.chatId} len=${msg.content.length}`,
      );
      // owner 绑定：扫码已知则直接校验；未知则首个私聊发消息的人成为 owner。
      if (!cmdCtx.ownerOpenId) {
        if (msg.chatType !== "p2p") return;
        cmdCtx.ownerOpenId = msg.senderId;
        larkConfig.ownerOpenId = msg.senderId;
        saveLarkConfig(larkConfig);
        bootLog.info(`owner 已绑定: ${msg.senderId}`);
      } else if (msg.senderId !== cmdCtx.ownerOpenId) {
        larkLog.debug(`忽略非 owner 消息 from=${msg.senderId}`);
        return;
      }

      const ingested = toIngestedMessage(
        msg,
        resolveLarkConversationType(msg, registry),
      );

      // 命令路由
      const { handled } = await handleCommand(msg, cmdCtx);
      if (handled) {
        larkLog.info("命令已处理");
        return;
      }

      let resolvedType = registry.getType(msg.chatId);
      if (!resolvedType && msg.chatType === "p2p") {
        registry.register(msg.chatId, "dm");
        resolvedType = "dm";
      }

      if (!resolvedType) {
        await channel.send(msg.chatId, {
          text: "这个群还没有注册为日记群或其它受管会话，已忽略本条消息。",
        });
        return;
      }

      const lens = parseLens(msg.content);
      if (lens && resolvedType !== "diary") {
        const lensChatType = msg.threadId || resolvedType === "notification"
          ? "thread"
          : resolvedType;
        await handleLensMessage(
          msg,
          ingested,
          channel,
          harnessManager,
          lensChatType,
          lens,
        );
        return;
      }

      if (msg.threadId) {
        await handleChatMessage(msg, ingested, channel, harnessManager, "thread");
      } else if (resolvedType === "diary") {
        await handleDiaryMessage(
          msg,
          ingested,
          channel,
          harnessManager,
          isDiaryEntryMessage(msg) ? "entry" : "reply",
        );
      } else if (resolvedType === "notification") {
        const handledNotification = await handleNotificationMessage(
          msg,
          ingested,
          channel,
          harnessManager,
        );
        if (!handledNotification) {
          await channel.send(msg.chatId, {
            text: "这条通知群消息没有关联到知识卡片，已忽略。",
          });
        }
      } else if (resolvedType === "topic") {
        await handleChatMessage(msg, ingested, channel, harnessManager, "topic");
      } else {
        await handleChatMessage(msg, ingested, channel, harnessManager, "dm");
      }
    },
    cardAction: async (evt: CardActionEvent) => {
      if (cmdCtx.ownerOpenId && evt.operator.openId !== cmdCtx.ownerOpenId) {
        larkLog.debug(`忽略非 owner 卡片动作 from=${evt.operator.openId}`);
        return;
      }
      if (await handleScheduleAction(evt, channel)) return;
    },
    error: (err) => {
      larkLog.error("错误:", err.message);
    },
    reconnecting: () => {
      larkLog.warn("正在重连…");
    },
    reconnected: () => {
      larkLog.info("已重连");
    },
  });

  // ── 5. 定时任务 ──
  initSchedules(db, channel, harnessManager, registry, setting);

  // ── 6. 空闲清理 ──
  setInterval(() => {
    harnessManager.cleanupIdle(setting.sessions.policies).catch((err) => {
      bootLog.error("空闲 scope 清理失败:", err);
    });
  }, setting.sessions.sweepIntervalMs);

  // ── 7. 启动 ──
  await channel.connect();
  bootLog.info("飞书 WebSocket 已连接，bot 启动完成 ✓");

  // 优雅退出
  const shutdown = () => {
    bootLog.info("关闭中…");
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleScheduleAction(
  evt: CardActionEvent,
  channel: ReturnType<typeof initChannel>,
): Promise<boolean> {
  const value = evt.action.value;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.action !== "toggle_schedule") return false;
  const scheduleId = record.schedule_id;
  if (typeof scheduleId !== "string") return false;

  let config;
  try {
    config = toggleScheduleEnabled(scheduleId);
  } catch {
    await channel.send(evt.chatId, { text: `定时任务不存在：${scheduleId}` });
    return true;
  }
  await channel.updateCard(evt.messageId, renderSchedulesCard(config));
  return true;
}

function resolveLarkConversationType(
  msg: NormalizedMessage,
  registry: ChatRegistry,
): ConversationType {
  if (msg.threadId) return "thread";
  const registered = registry.getType(msg.chatId);
  if (registered) return registered;
  if (msg.chatType === "p2p") return "dm";
  return "topic";
}

// ── CLI ──────────────────────────────────────────────────────────────
const command = process.argv[2] ?? "run";
switch (command) {
  case "start":
    startDaemon();
    break;
  case "stop":
    stopDaemon();
    break;
  case "status":
    showStatus();
    break;
  case "run":
    runForeground().catch((err) => {
      bootLog.error("启动失败:", err);
      process.exit(1);
    });
    break;
  default:
    bootLog.error(`未知命令: ${command}（可用: start | stop | status | run）`);
    process.exit(1);
}
