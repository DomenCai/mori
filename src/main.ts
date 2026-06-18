import { getDb, initDb, closeDb } from "./storage/db.js";
import {
  loadLarkConfig,
  saveLarkConfig,
  loadLlmConfig,
  resolveModelRoute,
  sessionsDir,
  type LarkConfig,
} from "./config.js";
import { initChannel } from "./lark/channel.js";
import { runRegistrationWizard } from "./lark/setup.js";
import { ChatRegistry } from "./lark/chatRegistry.js";
import { handleCommand, type CommandContext } from "./lark/commands.js";
import { HarnessManager, type HarnessEntry } from "./agent/harness.js";
import { renderThinkingCard, renderMarkdownCard } from "./lark/cards.js";
import { initSchedules } from "./schedule/cron.js";
import type { DiaryService } from "./diary/service.js";
import type { NormalizedMessage, LarkChannel } from "@larksuite/channel";

async function main() {
  // ── 1. 配置 & 数据库 ──
  let loaded = loadLarkConfig();
  if (!loaded) {
    loaded = await runRegistrationWizard();
    saveLarkConfig(loaded);
    console.log(`[boot] 飞书配置已保存到 ~/.personal-agent/config.json`);
  }
  const larkConfig: LarkConfig = loaded;
  const llmConfig = loadLlmConfig();

  console.log("[boot] 配置加载完成");

  const companionRoute = {
    name: "companion" as const,
    ...resolveModelRoute("companion", llmConfig),
  };
  const weeklyRoute = {
    name: "weekly" as const,
    ...resolveModelRoute("weekly", llmConfig),
  };
  console.log(
    `[boot] 模型路由: companion → ${companionRoute.model.id}, weekly → ${weeklyRoute.model.id}`,
  );

  const db = getDb();
  initDb(db);
  console.log("[boot] SQLite 初始化完成");

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
      // owner 绑定：扫码已知则直接校验；未知则首个私聊发消息的人成为 owner。
      if (!cmdCtx.ownerOpenId) {
        if (msg.chatType !== "p2p") return;
        cmdCtx.ownerOpenId = msg.senderId;
        saveLarkConfig({ ...larkConfig, ownerOpenId: msg.senderId });
        console.log(`[boot] owner 已绑定: ${msg.senderId}`);
      } else if (msg.senderId !== cmdCtx.ownerOpenId) {
        return;
      }

      // 命令路由
      const { handled } = await handleCommand(msg, cmdCtx);
      if (handled) return;

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
      console.error("[lark] 错误:", err.message);
    },
    reconnecting: () => {
      console.log("[lark] 正在重连…");
    },
    reconnected: () => {
      console.log("[lark] 已重连");
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
  console.log("[boot] 飞书 WebSocket 已连接，bot 启动完成 ✓");

  // 优雅退出
  const shutdown = () => {
    console.log("[shutdown] 关闭中…");
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
            try {
              await entry.harness.prompt(msg.content);
            } catch (err) {
              promptError = err;
              console.error("[diary] prompt 失败:", err);
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

  console.warn(`[diary] episode 缺失，触发 followUp: diary_entry_id=${diaryEntryId}`);
  try {
    await entry.harness.followUp(
      "你还没有为这篇日记写 episode。请现在调用 write_episode 工具完成蒸馏。",
    );
    await entry.harness.waitForIdle();
  } catch (err) {
    console.error("[diary] episode followUp 失败，使用兜底 episode:", err);
    diaryService.saveFallbackEpisode(diaryEntryId, content);
    return { fallbackReason: "episode followUp 失败，已保存最小兜底 episode" };
  }

  if (diaryService.hasEpisode(diaryEntryId)) return {};

  console.warn(`[diary] followUp 后 episode 仍缺失，使用兜底: diary_entry_id=${diaryEntryId}`);
  diaryService.saveFallbackEpisode(diaryEntryId, content);
  return { fallbackReason: "模型未写 episode，已保存最小兜底 episode" };
}

function appendStatus(fullText: string, status: string): string {
  return fullText ? `${fullText}\n\n${status}` : status;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
