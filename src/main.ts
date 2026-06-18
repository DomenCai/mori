#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { getDb, initDb, closeDb } from "./storage/db.js";
import {
  loadLarkConfig,
  saveLarkConfig,
  loadLlmConfig,
  resolveModelRoute,
  sessionsDir,
  logsDir,
  pidPath,
  type LarkConfig,
} from "./config.js";
import { initChannel } from "./lark/channel.js";
import { runRegistrationWizard } from "./lark/setup.js";
import { ChatRegistry } from "./lark/chatRegistry.js";
import { handleCommand, type CommandContext } from "./lark/commands.js";
import { HarnessManager, type HarnessEntry } from "./agent/harness.js";
import { renderThinkingCard, renderMarkdownCard } from "./lark/cards.js";
import { initSchedules } from "./schedule/cron.js";
import { logger } from "./log.js";
import type { DiaryService } from "./diary/service.js";
import type { NormalizedMessage, LarkChannel } from "@larksuite/channel";

const bootLog = logger("boot");
const larkLog = logger("lark");
const diaryLog = logger("diary");

async function runForeground() {
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
  const registry = new ChatRegistry(db);

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
        saveLarkConfig({ ...larkConfig, ownerOpenId: msg.senderId });
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
        await handleDiaryMessage(msg, channel, harnessManager);
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

// ── 日记群消息处理 ──
async function handleDiaryMessage(
  msg: NormalizedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
): Promise<void> {
  const entry = await harnessManager.getOrCreate(msg.chatId, "diary");
  const diaryService = harnessManager.getDiaryService();

  // 1. 存原文
  const diaryEntryId = diaryService.saveDiaryEntry({
    chatId: msg.chatId,
    content: msg.content,
    source: "lark",
    inputType: "text",
  });
  entry.currentDiaryEntryId = diaryEntryId;
  diaryLog.info(`处理日记 chat=${msg.chatId} entryId=${diaryEntryId}`);

  // 2. 流式回复
  await channel.stream(
    msg.chatId,
    {
      card: {
        initial: renderThinkingCard(),
        producer: async (ctrl) => {
          let fullText = "";

          const unsubscribe = entry.harness.subscribe(async (event) => {
            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_delta"
            ) {
              fullText += event.assistantMessageEvent.delta;
              await ctrl.update(renderMarkdownCard(fullText));
            }
            if (event.type === "tool_execution_start") {
              const toolLabel: Record<string, string> = {
                write_episode: "📝 正在写 Episode…",
                upsert_working_item: "💾 正在更新工作集…",
                search_diary: "🔍 正在搜索日记…",
              };
              const hint = toolLabel[event.toolName];
              if (hint) {
                await ctrl.update(
                  renderMarkdownCard(fullText + `\n\n*${hint}*`),
                );
              }
            }
            if (event.type === "tool_execution_end" && !event.isError) {
              const toolLabel: Record<string, string> = {
                write_episode: "✅ Episode 已保存",
                upsert_working_item: "✅ 工作集已更新",
              };
              const hint = toolLabel[event.toolName];
              if (hint) {
                await ctrl.update(
                  renderMarkdownCard(fullText + `\n\n*${hint}*`),
                );
              }
            }
          });

          try {
            let promptError: unknown = null;
            const started = Date.now();
            try {
              await entry.harness.prompt(msg.content);
              diaryLog.info(`prompt 完成 耗时=${Date.now() - started}ms`);
            } catch (err) {
              promptError = err;
              diaryLog.error("prompt 失败:", err);
            }

            if (promptError) {
              if (!diaryService.hasEpisode(diaryEntryId)) {
                diaryService.saveFallbackEpisode(diaryEntryId, msg.content);
              }
              await ctrl.update(
                renderMarkdownCard(
                  appendStatus(
                    fullText,
                    `> 处理失败，已保存原文和兜底 episode：${formatError(promptError)}`,
                  ),
                ),
              );
              return;
            }

            const episodeResult = await ensureDiaryEpisode(
              diaryService,
              entry,
              diaryEntryId,
              msg.content,
            );
            const finalText = episodeResult.fallbackReason
              ? appendStatus(fullText, `> ${episodeResult.fallbackReason}`)
              : fullText || "（已处理）";
            await ctrl.update(renderMarkdownCard(finalText));
          } finally {
            unsubscribe();
          }
        },
      },
    },
    { replyTo: msg.messageId },
  );
}

// ── 普通聊天消息处理 ──
async function handleChatMessage(
  msg: NormalizedMessage,
  channel: LarkChannel,
  harnessManager: HarnessManager,
  chatType: string,
): Promise<void> {
  const type = chatType === "diary" ? "diary" : "dm";
  const entry = await harnessManager.getOrCreate(msg.chatId, type);
  larkLog.info(`处理对话 chat=${msg.chatId} type=${type}`);
  const started = Date.now();

  await channel.stream(
    msg.chatId,
    {
      card: {
        initial: renderThinkingCard(),
        producer: async (ctrl) => {
          let fullText = "";

          const unsubscribe = entry.harness.subscribe(async (event) => {
            if (
              event.type === "message_update" &&
              event.assistantMessageEvent.type === "text_delta"
            ) {
              fullText += event.assistantMessageEvent.delta;
              await ctrl.update(renderMarkdownCard(fullText));
            }
          });

          try {
            await entry.harness.prompt(msg.content);
            larkLog.info(
              `回复完成 chat=${msg.chatId} 耗时=${Date.now() - started}ms`,
            );
            await ctrl.update(renderMarkdownCard(fullText || "（已处理）"));
          } finally {
            unsubscribe();
          }
        },
      },
    },
    { replyTo: msg.messageId },
  );
}

async function ensureDiaryEpisode(
  diaryService: DiaryService,
  entry: HarnessEntry,
  diaryEntryId: string,
  content: string,
): Promise<{ fallbackReason?: string }> {
  if (diaryService.hasEpisode(diaryEntryId)) return {};

  diaryLog.warn(`episode 缺失，触发 followUp: diary_entry_id=${diaryEntryId}`);
  try {
    await entry.harness.followUp(
      "你还没有为这篇日记写 episode。请现在调用 write_episode 工具完成蒸馏。",
    );
    await entry.harness.waitForIdle();
  } catch (err) {
    diaryLog.error("episode followUp 失败，使用兜底 episode:", err);
    diaryService.saveFallbackEpisode(diaryEntryId, content);
    return { fallbackReason: "episode followUp 失败，已保存最小兜底 episode" };
  }

  if (diaryService.hasEpisode(diaryEntryId)) return {};

  diaryLog.warn(`followUp 后 episode 仍缺失，使用兜底: diary_entry_id=${diaryEntryId}`);
  diaryService.saveFallbackEpisode(diaryEntryId, content);
  return { fallbackReason: "模型未写 episode，已保存最小兜底 episode" };
}

function appendStatus(fullText: string, status: string): string {
  return fullText ? `${fullText}\n\n${status}` : status;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── CLI ──────────────────────────────────────────────────────────────
// start：后台 detached 子进程跑 `run`，stdio 重定向到 logs/agent.log。
// pid 文件写入启动时间和脚本路径，stop/status 会先校验进程归属，避免 PID 复用误杀。

interface PidRecord {
  version: 1;
  pid: number;
  scriptPath: string;
  startedAt: string;
}

interface LegacyPidRecord {
  legacy: true;
  pid: number;
}

type StoredPidRecord = PidRecord | LegacyPidRecord;

type DaemonState =
  | { kind: "none" }
  | { kind: "running"; record: PidRecord }
  | { kind: "stale"; record: StoredPidRecord | null }
  | { kind: "unverified"; pid: number; reason: string };

function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function readPidRecord(): StoredPidRecord | null {
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, "utf-8").trim();
  const legacyPid = Number(raw);
  if (/^\d+$/.test(raw) && isValidPid(legacyPid)) {
    return { legacy: true, pid: legacyPid };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PidRecord>;
    if (
      parsed.version === 1 &&
      isValidPid(parsed.pid) &&
      typeof parsed.scriptPath === "string" &&
      parsed.scriptPath.length > 0 &&
      typeof parsed.startedAt === "string" &&
      parsed.startedAt.length > 0
    ) {
      return {
        version: 1,
        pid: parsed.pid,
        scriptPath: parsed.scriptPath,
        startedAt: parsed.startedAt,
      };
    }
  } catch {
    // Malformed pid files are treated as stale runtime state.
  }
  return null;
}

function isAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessField(pid: number, field: "args" | "lstart"): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function verifyManagedProcess(record: PidRecord): "owned" | "other" | "unknown" {
  const startedAt = readProcessField(record.pid, "lstart");
  const command = readProcessField(record.pid, "args");
  if (!startedAt || !command) return "unknown";
  if (
    startedAt === record.startedAt &&
    command.includes(record.scriptPath) &&
    /(?:^|\s)run(?:\s|$)/.test(command)
  ) {
    return "owned";
  }
  return "other";
}

function readDaemonState(): DaemonState {
  if (!existsSync(pidPath)) return { kind: "none" };

  const record = readPidRecord();
  if (!record) return { kind: "stale", record: null };
  if (!isAlive(record.pid)) return { kind: "stale", record };
  if ("legacy" in record) {
    return {
      kind: "unverified",
      pid: record.pid,
      reason: "pid 文件为旧格式，缺少进程归属校验信息",
    };
  }

  const verdict = verifyManagedProcess(record);
  if (verdict === "owned") return { kind: "running", record };
  if (verdict === "other") return { kind: "stale", record };
  return {
    kind: "unverified",
    pid: record.pid,
    reason: "无法读取进程命令或启动时间，不能安全确认归属",
  };
}

function removePidFile(): void {
  if (existsSync(pidPath)) unlinkSync(pidPath);
}

function writePidRecord(pid: number): boolean {
  const scriptPath = process.argv[1];
  const startedAt = readProcessField(pid, "lstart");
  if (!scriptPath || !startedAt) return false;

  const record: PidRecord = {
    version: 1,
    pid,
    scriptPath,
    startedAt,
  };
  writeFileSync(pidPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return true;
}

function startDaemon(): void {
  const state = readDaemonState();
  if (state.kind === "running") {
    bootLog.error(`已在运行 (pid ${state.record.pid})`);
    process.exit(1);
  }
  if (state.kind === "unverified") {
    bootLog.error(`${state.reason}，请先手动检查 pid ${state.pid}`);
    process.exit(1);
  }
  if (state.kind === "stale") removePidFile();

  if (!loadLarkConfig()) {
    bootLog.error(
      "尚未完成飞书配置，请先前台运行 `personal-agent run` 扫码注册，再用 start。",
    );
    process.exit(1);
  }

  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, "agent.log");
  const fd = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [process.argv[1], "run"],
    {
      detached: true,
      stdio: ["ignore", fd, fd],
    },
  );
  closeSync(fd);

  if (!child.pid || !writePidRecord(child.pid)) {
    child.kill("SIGTERM");
    bootLog.error("启动失败：无法校验后台进程信息");
    process.exit(1);
  }
  child.unref();
  bootLog.info(`已启动 (pid ${child.pid})，日志: ${logFile}`);
}

function stopDaemon(): void {
  const state = readDaemonState();
  if (state.kind === "none" || state.kind === "stale") {
    bootLog.info("未在运行");
    if (state.kind === "stale") removePidFile();
    return;
  }
  if (state.kind === "unverified") {
    bootLog.error(`${state.reason}，拒绝自动停止 pid ${state.pid}`);
    process.exit(1);
  }

  process.kill(state.record.pid, "SIGTERM");
  removePidFile();
  bootLog.info(`已停止 (pid ${state.record.pid})`);
}

function showStatus(): void {
  const state = readDaemonState();
  if (state.kind === "running") {
    bootLog.info(`运行中 (pid ${state.record.pid})，日志: ${join(logsDir, "agent.log")}`);
    return;
  }
  if (state.kind === "unverified") {
    bootLog.warn(`${state.reason}，pid=${state.pid}`);
    return;
  }
  if (state.kind === "stale") removePidFile();
  bootLog.info("未运行");
}

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
