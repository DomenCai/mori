import type { ApiMessageItem, CardActionEvent, NormalizedMessage } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { AgentService, type HarnessModelProfile } from "../agent/index.js";
import {
  loadLarkConfig,
  saveLarkConfig,
  resolveProfile,
  sessionsDir,
  type LarkConfig,
  type LlmConfig,
  type SettingConfig,
} from "../config.js";
import type { ConversationType } from "../ingest/message.js";
import { logger } from "../log.js";
import { initSchedules, runScheduleNow } from "../schedule/cron.js";
import {
  loadSchedulesConfig,
  setScheduleEnabled,
  toggleScheduleEnabled,
} from "../schedule/config.js";
import { ChatRegistry } from "./chatRegistry.js";
import { larkCardToText } from "./cardText.js";
import { initChannel } from "./channel.js";
import {
  createDiaryGroup,
  handleCommand,
  renderSchedulesCard,
  type CommandContext,
} from "./commands.js";
import { renderWelcomeCard } from "./cards.js";
import { toIngestedMessage } from "./ingest.js";
import { parseLens } from "./lenses.js";
import {
  handleChatMessage,
  handleDiaryMessage,
  handleLensMessage,
  handleNotificationMessage,
  isDiaryEntryMessage,
} from "./messageHandlers.js";
import { runRegistrationWizard } from "./setup.js";

const bootLog = logger("boot");
const larkLog = logger("lark");

export async function startLarkBot(
  db: Database.Database,
  llmConfig: LlmConfig,
  setting: SettingConfig,
): Promise<void> {
  let loaded = loadLarkConfig();
  if (!loaded) {
    loaded = await runRegistrationWizard();
    saveLarkConfig(loaded);
    bootLog.info("飞书配置已保存到 lark_config.json");
  }
  const larkConfig: LarkConfig = loaded;

  const profiles: Record<string, HarnessModelProfile> = {};
  for (const name of Object.keys(llmConfig.model_profiles)) {
    profiles[name] = { name, ...resolveProfile(name, llmConfig) };
  }
  bootLog.info(
    `模型档位: ${Object.values(profiles)
      .map((p) => `${p.name} → ${p.model.id}`)
      .join(", ")}`,
  );

  const channel = initChannel(larkConfig);
  const registry = new ChatRegistry(larkConfig, saveLarkConfig);
  const agentService = new AgentService({
    db,
    sessionsDir,
    profiles,
    chatTypes: llmConfig.chat_types,
    channel,
    registry,
  });
  const cmdCtx: CommandContext = {
    channel,
    db,
    registry,
    agentService,
    ownerOpenId: larkConfig.ownerOpenId ?? "",
  };

  channel.on({
    message: async (msg: NormalizedMessage) => {
      await handleLarkMessage(
        msg,
        cmdCtx,
        larkConfig,
        registry,
        channel,
        agentService,
      );
    },
    cardAction: async (evt: CardActionEvent) => {
      if (cmdCtx.ownerOpenId && evt.operator.openId !== cmdCtx.ownerOpenId) {
        larkLog.debug(`忽略非 owner 卡片动作 from=${evt.operator.openId}`);
        return;
      }
      if (await handleOnboardingAction(evt, channel, registry, cmdCtx.ownerOpenId)) {
        return;
      }
      if (
        await handleScheduleAction(
          evt,
          channel,
          db,
          agentService,
          registry,
          setting,
        )
      ) return;
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

  initSchedules(db, channel, agentService, registry, setting);
  setInterval(() => {
    agentService.cleanupIdle(setting.sessions.policies).catch((err) => {
      bootLog.error("空闲 scope 清理失败:", err);
    });
  }, setting.sessions.sweepIntervalMs);

  await channel.connect();
  bootLog.info("飞书 WebSocket 已连接，bot 启动完成 ✓");
}

async function handleLarkMessage(
  msg: NormalizedMessage,
  cmdCtx: CommandContext,
  larkConfig: LarkConfig,
  registry: ChatRegistry,
  channel: ReturnType<typeof initChannel>,
  agentService: AgentService,
): Promise<void> {
  larkLog.info(
    `收到消息 from=${msg.senderId} type=${msg.chatType} chat=${msg.chatId} contentLen=${msg.content.length}`,
  );
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

  if (msg.chatType === "p2p" && !larkConfig.onboardedAt) {
    await channel.send(msg.chatId, { card: renderWelcomeCard() });
    larkConfig.onboardedAt = new Date().toISOString();
    saveLarkConfig(larkConfig);
    bootLog.info(`已推送首次欢迎引导 to=${msg.senderId}`);
  }

  const effectiveMsg = await withInteractiveCardContentFallback(msg, channel);
  larkLog.debug(`消息详情: ${effectiveMsg.content}`);

  const ingested = toIngestedMessage(
    effectiveMsg,
    resolveLarkConversationType(effectiveMsg, registry),
  );

  const { handled } = await handleCommand(effectiveMsg, cmdCtx);
  if (handled) {
    larkLog.info("命令已处理");
    return;
  }

  let resolvedType = registry.getType(effectiveMsg.chatId);
  if (!resolvedType && effectiveMsg.chatType === "p2p") {
    registry.register(effectiveMsg.chatId, "dm");
    resolvedType = "dm";
  }

  if (!resolvedType) {
    await channel.send(effectiveMsg.chatId, {
      text: "这个群还没有注册为日记群或其它受管会话，已忽略本条消息。",
    });
    return;
  }

  const lens = parseLens(effectiveMsg.content);
  if (lens && resolvedType !== "diary") {
    const lensChatType = effectiveMsg.threadId || resolvedType === "notification"
      ? "thread"
      : resolvedType;
    await handleLensMessage(
      effectiveMsg,
      ingested,
      channel,
      agentService,
      lensChatType,
      lens,
    );
    return;
  }

  if (effectiveMsg.threadId) {
    await handleChatMessage(effectiveMsg, ingested, channel, agentService, "thread");
  } else if (resolvedType === "diary") {
    await handleDiaryMessage(
      effectiveMsg,
      ingested,
      channel,
      agentService,
      isDiaryEntryMessage(effectiveMsg) ? "entry" : "reply",
    );
  } else if (resolvedType === "notification") {
    const handledNotification = await handleNotificationMessage(
      effectiveMsg,
      ingested,
      channel,
      agentService,
    );
    if (!handledNotification) {
      await channel.send(effectiveMsg.chatId, {
        text: "这条通知群消息没有关联到知识卡片，已忽略。",
      });
    }
  } else if (resolvedType === "topic") {
    await handleChatMessage(effectiveMsg, ingested, channel, agentService, "topic");
  } else {
    await handleChatMessage(msg, ingested, channel, agentService, "dm");
  }
}

async function withInteractiveCardContentFallback(
  msg: NormalizedMessage,
  channel: ReturnType<typeof initChannel>,
): Promise<NormalizedMessage> {
  if (!msg.content.includes("[interactive card]")) return msg;

  try {
    const items = await channel.fetchRawMessage(msg.messageId);
    const interactiveItems = items.filter((item) => item.msg_type === "interactive");
    larkLog.info(
      `诊断卡片 raw message=${msg.messageId} rawType=${msg.rawContentType} total=${items.length} interactive=${interactiveItems.length} types=${summarizeMessageTypes(items)}`,
    );

    const cardTexts = interactiveItems
      .map((item) => extractInteractiveCardText(item.body?.content ?? ""))
      .filter((text): text is string => Boolean(text))
      .map((text) => text.trim());
    const beforePlaceholders = countInteractiveCardPlaceholders(msg.content);
    const content = replaceInteractiveCardPlaceholders(msg.content, cardTexts).trim();
    if (!content) {
      larkLog.info(`诊断卡片 raw 未提取到文本 message=${msg.messageId}`);
      return msg;
    }

    larkLog.info(
      `卡片正文已从 raw 恢复 message=${msg.messageId} cards=${cardTexts.length} placeholders=${beforePlaceholders}->${countInteractiveCardPlaceholders(content)} chars=${content.length}`,
    );
    return { ...msg, content };
  } catch (err) {
    larkLog.warn(
      `诊断卡片 raw 拉取失败 message=${msg.messageId} rawType=${msg.rawContentType} error=${formatLogError(err)}`,
    );
    return msg;
  }
}

function countInteractiveCardPlaceholders(content: string): number {
  return content.match(/\[interactive card\]/g)?.length ?? 0;
}

function replaceInteractiveCardPlaceholders(content: string, cardTexts: string[]): string {
  let index = 0;
  return content.replace(/\[interactive card\]/g, (placeholder) => {
    const text = cardTexts[index++];
    return text || placeholder;
  });
}

function summarizeMessageTypes(items: ApiMessageItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const type = item.msg_type ?? "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(",");
}

function formatLogError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function extractInteractiveCardText(rawContent: string): string | null {
  const parsed = safeJsonParse(rawContent);
  if (!parsed) return null;

  const text = larkCardToText(parsed);
  return text || null;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function handleOnboardingAction(
  evt: CardActionEvent,
  channel: ReturnType<typeof initChannel>,
  registry: ChatRegistry,
  ownerOpenId: string,
): Promise<boolean> {
  const value = evt.action.value;
  if (!value || typeof value !== "object") return false;
  if ((value as Record<string, unknown>).action !== "onboard_diary_group") {
    return false;
  }
  if (registry.getDiaryChats().length > 0) {
    await channel.send(evt.chatId, {
      text: "你已经有日记群了，去那个群里记日记就行～",
    });
    return true;
  }
  await createDiaryGroup(channel, registry, ownerOpenId);
  await channel.send(evt.chatId, {
    text: "✅ 日记群已创建，去新群里记第一篇日记吧！",
  });
  return true;
}

async function handleScheduleAction(
  evt: CardActionEvent,
  channel: ReturnType<typeof initChannel>,
  db: Database.Database,
  agentService: AgentService,
  registry: ChatRegistry,
  setting: SettingConfig,
): Promise<boolean> {
  const value = evt.action.value;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.action !== "toggle_schedule" && record.action !== "run_schedule") {
    return false;
  }
  const scheduleId = record.schedule_id;
  if (typeof scheduleId !== "string") return false;
  if (record.action === "run_schedule") {
    await handleRunScheduleAction(
      evt,
      channel,
      scheduleId,
      db,
      agentService,
      registry,
      setting,
    );
    return true;
  }

  const enabled = parseCardBoolean(record.enabled);
  larkLog.info(
    `收到定时任务卡片动作 message=${evt.messageId} chat=${evt.chatId} id=${scheduleId} target=${enabled ?? "toggle"} value=${JSON.stringify(record)}`,
  );

  let config;
  try {
    config = enabled !== undefined
      ? setScheduleEnabled(scheduleId, enabled)
      : toggleScheduleEnabled(scheduleId);
  } catch {
    await channel.send(evt.chatId, { text: `定时任务不存在：${scheduleId}` });
    return true;
  }
  const current = config.schedules.find((item) => item.id === scheduleId);
  larkLog.info(`定时任务状态已处理 message=${evt.messageId} id=${scheduleId} saved=${current?.enabled}`);
  scheduleCardRefresh(channel, evt.messageId, scheduleId);
  return true;
}

async function handleRunScheduleAction(
  evt: CardActionEvent,
  channel: ReturnType<typeof initChannel>,
  scheduleId: string,
  db: Database.Database,
  agentService: AgentService,
  registry: ChatRegistry,
  setting: SettingConfig,
): Promise<void> {
  larkLog.info(
    `收到定时任务立即运行动作 message=${evt.messageId} chat=${evt.chatId} id=${scheduleId} value=${JSON.stringify(evt.action.value)}`,
  );
  const schedule = loadSchedulesConfig().schedules.find((item) => item.id === scheduleId);
  if (!schedule) {
    await channel.send(evt.chatId, { text: `定时任务不存在：${scheduleId}` });
    return;
  }

  const { messageId } = await channel.send(evt.chatId, { text: `已开始运行：${schedule.name}（${schedule.id}）` });
  setTimeout(() => {
    void (async () => {
      try {
        await runScheduleNow(
          scheduleId,
          db,
          channel,
          agentService,
          registry,
          setting,
        );
        await channel.editMessage(messageId, `运行完成：${schedule.name}（${schedule.id}）`);
      } catch (err) {
        larkLog.error(`定时任务立即运行失败 id=${scheduleId}:`, err);
        await channel.editMessage(messageId, `运行失败：${schedule.name}（${schedule.id}）\n${formatScheduleRunError(err)}`);
      }
    })();
  }, 0);
}

function scheduleCardRefresh(
  channel: ReturnType<typeof initChannel>,
  messageId: string,
  scheduleId: string,
): void {
  setTimeout(() => {
    void refreshScheduleCard(channel, messageId, scheduleId);
  }, 100);
}

async function refreshScheduleCard(
  channel: ReturnType<typeof initChannel>,
  messageId: string,
  scheduleId: string,
): Promise<void> {
  const config = loadSchedulesConfig();
  const current = config.schedules.find((item) => item.id === scheduleId);
  larkLog.info(`准备延迟更新定时任务卡片 message=${messageId} id=${scheduleId} saved=${current?.enabled}`);
  try {
    await channel.updateCard(messageId, renderSchedulesCard(config));
    larkLog.info(`定时任务卡片延迟更新成功 message=${messageId} id=${scheduleId}`);
  } catch (err) {
    larkLog.error(`定时任务卡片延迟更新失败 message=${messageId} id=${scheduleId}:`, err);
  }
}

function parseCardBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function formatScheduleRunError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
