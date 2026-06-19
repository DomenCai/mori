#!/usr/bin/env node
import { getDb, initDb, closeDb } from "./storage/db.js";
import {
  loadLarkConfig,
  saveLarkConfig,
  loadLlmConfig,
  resolveModelRoute,
  sessionsDir,
  logsDir,
  type LarkConfig,
} from "./config.js";
import { initChannel } from "./lark/channel.js";
import { runRegistrationWizard } from "./lark/setup.js";
import { ChatRegistry } from "./lark/chatRegistry.js";
import { handleCommand, type CommandContext } from "./lark/commands.js";
import { HarnessManager } from "./agent/harness.js";
import {
  handleChatMessage,
  handleDiaryMessage,
  isDiaryEntryMessage,
} from "./lark/messageHandlers.js";
import { initSchedules } from "./schedule/cron.js";
import { installDailyFileLogging, logger } from "./log.js";
import { startDaemon, stopDaemon, showStatus } from "./daemon.js";
import type { NormalizedMessage } from "@larksuite/channel";

const bootLog = logger("boot");
const larkLog = logger("lark");

async function runForeground() {
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
    bootLog.info("飞书配置已保存到 ~/.personal-agent/config.json");
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

      // 对话处理
      if (resolvedType === "diary") {
        await handleDiaryMessage(
          msg,
          channel,
          harnessManager,
          isDiaryEntryMessage(msg) ? "entry" : "reply",
        );
      } else {
        await handleChatMessage(msg, channel, harnessManager, resolvedType);
      }
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
  initSchedules(db, channel, harnessManager, registry);

  // ── 6. 空闲清理 ──
  setInterval(() => {
    harnessManager.cleanupIdle(60 * 60 * 1000);
  }, 5 * 60 * 1000);

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
