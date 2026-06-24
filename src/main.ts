#!/usr/bin/env node
import { getDb, initDb, closeDb } from "./storage/db.js";
import {
  loadLlmConfig,
  loadSetting,
  loadAppVersion,
  logsDir,
} from "./config.js";
import { installDailyFileLogging, logger } from "./log.js";
import { startDaemon, stopDaemon, showStatus } from "./daemon.js";
import { startLarkBot } from "./lark/bot.js";
import { MemoryService } from "./memory/service.js";

const bootLog = logger("boot");

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
  const llmConfig = loadLlmConfig();
  bootLog.info("配置加载完成");

  const db = getDb();
  initDb(db);
  bootLog.info("SQLite 初始化完成");

  // ── 2. 飞书 bot ──
  await startLarkBot(db, llmConfig, setting);

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
const HELP = `mori — 飞书优先的对话型个人思想伙伴

用法: mori <命令>

命令:
  run               前台运行（调试 / 首次扫码注册用）
  start             后台守护启动
  stop              停止后台守护
  status            查看运行状态
  profile add <文本>               添加身份画像
  profile remove <文本>            删除身份画像中的唯一子串
  profile replace <旧文本> -- <新文本>  替换身份画像中的唯一子串
  storyline close <id>             手动软关闭 storyline
  storyline reopen <id>            手动重新激活 storyline
  help, -h, --help  显示本帮助
  version, -v, --version  显示版本号

不带命令时默认为 run。`;

function runMemoryCli(fn: (memory: MemoryService) => void): void {
  const db = getDb();
  initDb(db);
  try {
    const memory = new MemoryService(db);
    memory.syncEditableMemoryFiles();
    fn(memory);
  } finally {
    closeDb();
  }
}

function failCli(message: string): never {
  console.error(message);
  process.exit(1);
}

function formatCliError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runProfileCli(args: string[]): void {
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === "add") {
      const newText = rest.join(" ").trim();
      if (!newText) failCli("用法: mori profile add <文本>");
      runMemoryCli((memory) => {
        memory.updateProfile({
          operation: "add",
          new_text: newText,
          reason: "manual_cli",
        });
      });
      console.log("身份画像已添加");
      return;
    }

    if (subcommand === "remove") {
      const oldText = rest.join(" ").trim();
      if (!oldText) failCli("用法: mori profile remove <文本>");
      runMemoryCli((memory) => {
        memory.updateProfile({
          operation: "remove",
          old_text: oldText,
          reason: "manual_cli",
        });
      });
      console.log("身份画像已删除");
      return;
    }

    if (subcommand === "replace") {
      const delimiter = rest.indexOf("--");
      if (delimiter < 0) failCli("用法: mori profile replace <旧文本> -- <新文本>");
      const oldText = rest.slice(0, delimiter).join(" ").trim();
      const newText = rest.slice(delimiter + 1).join(" ").trim();
      if (!oldText || !newText) failCli("用法: mori profile replace <旧文本> -- <新文本>");
      runMemoryCli((memory) => {
        memory.updateProfile({
          operation: "replace",
          old_text: oldText,
          new_text: newText,
          reason: "manual_cli",
        });
      });
      console.log("身份画像已替换");
      return;
    }

    failCli("用法: mori profile add <文本> | mori profile remove <文本> | mori profile replace <旧文本> -- <新文本>");
  } catch (err) {
    failCli(`身份画像修改失败：${formatCliError(err)}`);
  }
}

function runStorylineCli(args: string[]): void {
  const [subcommand, id] = args;
  if ((subcommand !== "close" && subcommand !== "reopen") || !id) {
    failCli("用法: mori storyline close <id> | mori storyline reopen <id>");
  }

  try {
    runMemoryCli((memory) => {
      memory.setStorylineStatus({
        id,
        status: subcommand === "close" ? "closed" : "active",
        reason: "manual_cli",
      });
    });
    console.log(subcommand === "close" ? "Storyline 已关闭" : "Storyline 已重新激活");
  } catch (err) {
    failCli(`Storyline 修改失败：${formatCliError(err)}`);
  }
}

const command = process.argv[2] ?? "run";
switch (command) {
  case "help":
  case "-h":
  case "--help":
    console.log(HELP);
    break;
  case "version":
  case "-v":
  case "--version":
    console.log(loadAppVersion());
    break;
  case "start":
    startDaemon();
    break;
  case "stop":
    stopDaemon();
    break;
  case "status":
    showStatus();
    break;
  case "profile":
    runProfileCli(process.argv.slice(3));
    break;
  case "storyline":
    runStorylineCli(process.argv.slice(3));
    break;
  case "run":
    runForeground().catch((err) => {
      bootLog.error("启动失败:", err);
      process.exit(1);
    });
    break;
  default:
    bootLog.error(`未知命令: ${command}（可用: run | start | stop | status | profile | storyline | help | version）`);
    process.exit(1);
}
