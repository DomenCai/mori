import type { LarkChannel, NormalizedMessage } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { ChatRegistry } from "./chatRegistry.js";
import type { AgentService } from "../agent/index.js";
import type { ConversationType, IngestedMessage } from "../ingest/message.js";
import { larkConversationId, larkMessageId } from "./ingest.js";
import { loadSchedulesConfig, type SchedulesConfig } from "../schedule/config.js";
import {
  renderChapterHistoryCard,
  renderDailyMemoryRunsCard,
  renderInfoCard,
  renderProfileHistoryCard,
  renderStorylineCard,
  renderStorylinesCard,
} from "./cards.js";
import { parseLens } from "./lenses.js";
import { loadAppVersion } from "../config.js";
import { saveClipContent } from "./messageHandlers.js";
import { nowISO } from "../utils.js";

export interface CommandContext {
  channel: LarkChannel;
  db: Database.Database;
  registry: ChatRegistry;
  agentService: AgentService;
  ownerOpenId: string;
}

interface CommandResult {
  handled: boolean;
}

interface ClipCommandTarget {
  content: string;
  originNote?: string;
}

function helpText(): string {
  return `**<font color='wathet'>/think <内容></font>** - 顺着为什么往下钻；也可回复一条消息使用
**<font color='wathet'>/rank <内容></font>** - 把一个领域砍到两三根生成器；也可回复一条消息使用
**<font color='wathet'>/plain <内容></font>** - 用大白话讲到能复述；也可回复一条消息使用
**<font color='wathet'>/new-diary-group</font>** - 创建一个日记群
**<font color='wathet'>/new-clip-group</font>** - 创建唯一收藏群
**<font color='wathet'>/clip <链接或文字></font>** - 直接收藏；也可回复通知只发 /clip
**<font color='wathet'>/new-chat <主题></font>** - 创建一个持续主题群
**<font color='wathet'>/new</font>** - 重置当前会话
**<font color='wathet'>/compact</font>** - 压缩当前会话上下文
**<font color='wathet'>/save [备注]</font>** - 保存当前会话片段
**<font color='wathet'>/profile</font>** - 查看身份画像
**<font color='wathet'>/profile history</font>** - 查看画像变更历史
**<font color='wathet'>/chapter</font>** - 查看当前主线
**<font color='wathet'>/chapter history</font>** - 查看当前主线变更历史
**<font color='wathet'>/storylines</font>** - 查看 active + recent dormant 叙事线
**<font color='wathet'>/storyline <id></font>** - 查看单条叙事线详情
**<font color='wathet'>/dream</font>** - 查看最近 7 天里有变更的 daily_memory runs
**<font color='wathet'>/dream <天数></font>** - 查看最近 N 天里有变更的 daily_memory runs
**<font color='wathet'>/dream YYYY-MM-DD</font>** - 查看某天 daily_memory 详情
**<font color='wathet'>/schedules</font>** - 查看定时任务配置
**<font color='wathet'>/consolidate</font>** - 手动触发周度合并`;
}

function truncateCommandText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim() || "对话存档";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export async function handleCommand(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const text = msg.content.trim();
  if (parseLens(text)) return { handled: false };
  if (!text.startsWith("/")) return { handled: false };

  const [cmd, ...args] = text.split(/\s+/);

  switch (cmd) {
    case "/help":
      return handleHelp(msg, ctx);
    case "/new-diary-group":
      return handleNewDiaryGroup(msg, ctx);
    case "/new-clip-group":
      return handleNewClipGroup(msg, ctx);
    case "/clip":
      return handleClipCommand(msg, ctx, args.join(" "));
    case "/new-chat":
      return handleNewChat(msg, ctx, args.join(" "));
    case "/new":
      return handleNew(msg, ctx);
    case "/compact":
      return handleCompact(msg, ctx);
    case "/save":
      return handleSave(msg, ctx);
    case "/profile":
      return handleProfile(msg, ctx);
    case "/chapter":
      return handleChapter(msg, ctx, args);
    case "/storylines":
      return handleStorylines(msg, ctx);
    case "/storyline":
      return handleStoryline(msg, ctx, args);
    case "/dream":
      return handleDream(msg, ctx, args);
    case "/schedules":
      return handleSchedules(msg, ctx);
    case "/consolidate":
      return handleConsolidate(msg, ctx);
    default:
      await ctx.channel.send(msg.chatId, {
        text: `未知命令: ${cmd}。发送 /help 查看可用命令。`,
      });
      return { handled: true };
  }
}

async function handleHelp(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const title = `命令列表 v${loadAppVersion()}`;
  await ctx.channel.send(msg.chatId, { card: renderInfoCard(title, helpText()) });
  return { handled: true };
}

export async function createDiaryGroup(
  channel: LarkChannel,
  registry: ChatRegistry,
  ownerOpenId: string,
): Promise<void> {
  const { chatId } = await channel.createChat({
    name: "日记群",
    description: "mori 日记",
    inviteUserIds: [ownerOpenId],
    userIdType: "open_id",
  });
  registry.register(chatId, "diary", "日记群");
}

export async function createClipGroup(
  channel: LarkChannel,
  registry: ChatRegistry,
  ownerOpenId: string,
): Promise<void> {
  const existing = registry.getClipChat();
  if (existing) return;
  const { chatId } = await channel.createChat({
    name: "mori 收藏",
    description: "mori 收藏群",
    inviteUserIds: [ownerOpenId],
    userIdType: "open_id",
  });
  registry.register(chatId, "clip", "mori 收藏");
}

async function handleNewDiaryGroup(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await createDiaryGroup(ctx.channel, ctx.registry, ctx.ownerOpenId);
  await ctx.channel.send(msg.chatId, {
    text: `✅ 日记群已创建，去新群里记日记吧！`,
  });
  return { handled: true };
}

async function handleNewClipGroup(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (ctx.registry.getClipChat()) {
    await ctx.channel.send(msg.chatId, { text: "收藏群已存在。" });
    return { handled: true };
  }
  await createClipGroup(ctx.channel, ctx.registry, ctx.ownerOpenId);
  await ctx.channel.send(msg.chatId, {
    text: "✅ 收藏群已创建，往里面丢链接或文字就会入库。",
  });
  return { handled: true };
}

async function handleClipCommand(
  msg: NormalizedMessage,
  ctx: CommandContext,
  content: string,
): Promise<CommandResult> {
  const clipTarget = resolveClipCommandTarget(msg, ctx, content);
  if (!clipTarget.content) {
    await ctx.channel.send(msg.chatId, {
      text: "用法：/clip <链接或文字>，或回复一条通知发送 /clip",
    });
    return { handled: true };
  }

  try {
    await ctx.channel.addReaction(msg.messageId, "OnIt");
  } catch {
    // 回执失败不影响收藏。
  }

  await saveClipContent(
    msg,
    commandIngestedMessage(msg, ctx, clipTarget.content),
    clipTarget.content,
    ctx.channel,
    ctx.agentService,
    { originNote: clipTarget.originNote },
  );
  return { handled: true };
}

function resolveClipCommandTarget(
  msg: NormalizedMessage,
  ctx: CommandContext,
  content: string,
): ClipCommandTarget {
  const explicit = content.trim();
  if (explicit) return { content: explicit };
  const parentId = larkMessageId(msg.replyToMessageId);
  if (!parentId) return { content: "" };
  const parent = ctx.agentService.getMessageService().get(parentId);
  const parentContent = parent?.content.trim() ?? "";
  if (!parentContent) return { content: "" };
  const sourceType = parent?.conversation_type === "notification" ? "notification" : "message";
  return {
    content: parentContent,
    originNote: `${sourceType}:${parentId}`,
  };
}

function commandIngestedMessage(
  msg: NormalizedMessage,
  ctx: CommandContext,
  content: string,
): IngestedMessage {
  const registered = ctx.registry.getType(msg.chatId);
  const conversationType: ConversationType = msg.threadId
    ? "thread"
    : registered ?? (msg.chatType === "p2p" ? "dm" : "clip");
  return {
    id: larkMessageId(msg.messageId)!,
    source: "lark",
    conversationId: larkConversationId(msg),
    conversationType,
    role: "user",
    content,
    occurredAt: msg.createTime ? new Date(msg.createTime).toISOString() : nowISO(),
    replyTo: larkMessageId(msg.replyToMessageId),
    threadId: msg.threadId ?? null,
    rootId: larkMessageId(msg.rootId),
  };
}

async function handleNewChat(
  msg: NormalizedMessage,
  ctx: CommandContext,
  topic: string,
): Promise<CommandResult> {
  const name = topic.trim() || `主题群 · ${new Date().toLocaleDateString("zh-CN")}`;
  const { chatId } = await ctx.channel.createChat({
    name,
    description: "mori 主题群",
    inviteUserIds: [ctx.ownerOpenId],
    userIdType: "open_id",
  });
  ctx.registry.register(chatId, "topic", name);
  await ctx.channel.send(msg.chatId, {
    text: `✅ 主题群已创建：${name}`,
  });
  return { handled: true };
}

async function handleNew(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.agentService.resetSession(larkConversationId(msg));
  await ctx.channel.send(msg.chatId, { text: "🔄 会话已重置" });
  return { handled: true };
}

async function handleCompact(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.agentService.compactSession(larkConversationId(msg));
  await ctx.channel.send(msg.chatId, { text: "📦 上下文已压缩" });
  return { handled: true };
}

async function handleSave(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const registered = ctx.registry.getType(msg.chatId);
  if (registered === "diary" || (registered === "clip" && !msg.threadId)) {
    await ctx.channel.send(msg.chatId, {
      text: "这个群不支持 /save。",
    });
    return { handled: true };
  }

  try {
    await ctx.channel.addReaction(msg.messageId, "OnIt");
  } catch {
    // 回执失败不影响存档。
  }

  const scopeId = larkConversationId(msg);
  const session = ctx.agentService.getSessionRegistry().findUnclosedForScope(scopeId);
  if (!session?.segment_started_at) {
    await ctx.channel.send(msg.chatId, { text: "当前会话还没有可保存内容。" });
    return { handled: true };
  }

  const messages = ctx.agentService
    .getMessageService()
    .getConversationMessages(
      scopeId,
      session.segment_started_at,
      new Date().toISOString(),
    )
    .filter((item) => item.role === "user" || item.role === "assistant");
  const recent = messages.slice(-60);
  const firstUser = recent.find((item) => item.role === "user");
  if (!firstUser) {
    await ctx.channel.send(msg.chatId, { text: "当前会话还没有可保存内容。" });
    return { handled: true };
  }

  const omitted = messages.length > recent.length;
  const title = truncateCommandText(firstUser.content.split(/\r?\n/)[0] ?? "对话存档", 40);
  const body = [
    omitted ? "（已存最近 60 条）\n" : "",
    ...recent.map((item) => `## ${item.role}\n\n${item.content.trim()}`),
  ].join("\n\n").trim();
  const note = msg.content.trim().slice("/save".length).trim();
  const result = ctx.agentService.getVaultService().ingestNote({
    title,
    body,
    source_type: "conversation",
    origin_note: note || undefined,
  });
  await ctx.channel.send(msg.chatId, {
    text: `已存档：《${result.title}》`,
  });
  return { handled: true };
}

async function handleProfile(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const rest = msg.content.trim().slice("/profile".length).trim();
  const memory = ctx.agentService.getMemoryService();
  memory.syncEditableMemoryFiles();

  if (!rest) {
    const profile = memory.getProfile();
    await ctx.channel.send(msg.chatId, {
      card: renderInfoCard("📋 身份画像", profile),
    });
    return { handled: true };
  }

  if (rest === "history") {
    await ctx.channel.send(msg.chatId, {
      card: renderProfileHistoryCard(memory.getProfileRevisions(10)),
    });
    return { handled: true };
  }

  if (rest.startsWith("add ") || rest.startsWith("remove ") || rest.startsWith("replace ")) {
    await ctx.channel.send(msg.chatId, {
      text: "飞书命令只支持查看。修改身份画像请用 CLI：mori profile add/remove/replace。",
    });
    return { handled: true };
  }

  return sendProfileUsage(msg, ctx);
}

async function handleChapter(
  msg: NormalizedMessage,
  ctx: CommandContext,
  args: string[],
): Promise<CommandResult> {
  const memory = ctx.agentService.getMemoryService();
  memory.syncEditableMemoryFiles();

  if (args.length === 0) {
    const chapter = memory.getChapter().trim() || "（尚未建立当前主线）";
    await ctx.channel.send(msg.chatId, {
      card: renderInfoCard("🧭 当前主线", chapter),
    });
    return { handled: true };
  }

  if (args.length === 1 && args[0] === "history") {
    await ctx.channel.send(msg.chatId, {
      card: renderChapterHistoryCard(memory.getChapterRevisions(10)),
    });
    return { handled: true };
  }

  await ctx.channel.send(msg.chatId, {
    text: "用法：/chapter | /chapter history",
  });
  return { handled: true };
}

async function sendProfileUsage(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.channel.send(msg.chatId, {
    text: "用法：/profile | /profile history",
  });
  return { handled: true };
}

async function handleStorylines(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const items = ctx.agentService.getMemoryService().getVisibleStorylines();
  if (items.length === 0) {
    await ctx.channel.send(msg.chatId, { text: "暂无 storylines" });
    return { handled: true };
  }
  await ctx.channel.send(msg.chatId, { card: renderStorylinesCard(items) });
  return { handled: true };
}

async function handleStoryline(
  msg: NormalizedMessage,
  ctx: CommandContext,
  args: string[],
): Promise<CommandResult> {
  const memory = ctx.agentService.getMemoryService();
  const [first] = args;
  if (!first) return sendStorylineUsage(msg, ctx);

  if (first === "close" || first === "reopen") {
    await ctx.channel.send(msg.chatId, {
      text: "飞书命令只支持查看。修改 storyline 状态请用 CLI：mori storyline close/reopen <id>。",
    });
    return { handled: true };
  }

  const item = memory.getStoryline(first);
  if (!item) {
    await ctx.channel.send(msg.chatId, { text: `storyline 不存在：${first}` });
    return { handled: true };
  }
  const revisions = memory.getStorylineRevisions(first);
  await ctx.channel.send(msg.chatId, { card: renderStorylineCard(item, revisions) });
  return { handled: true };
}

async function sendStorylineUsage(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.channel.send(msg.chatId, {
    text: "用法：/storyline <id>",
  });
  return { handled: true };
}

async function handleDream(
  msg: NormalizedMessage,
  ctx: CommandContext,
  args: string[],
): Promise<CommandResult> {
  const memory = ctx.agentService.getMemoryService();
  const input = args[0];
  if (input && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const run = memory.getDailyMemoryRun(input);
    if (!run) {
      await ctx.channel.send(msg.chatId, { text: `没有 ${input} 的 daily_memory 记录` });
      return { handled: true };
    }
    await ctx.channel.send(msg.chatId, {
      card: renderDailyMemoryRunsCard([run], { expanded: true }),
    });
    return { handled: true };
  }

  const days = input ? Number(input) : 7;
  if (!Number.isInteger(days) || days <= 0) {
    await ctx.channel.send(msg.chatId, { text: "用法：/dream | /dream <天数> | /dream YYYY-MM-DD" });
    return { handled: true };
  }
  const runs = memory.getRecentDailyMemoryRuns(days)
    .filter((run) => run.storyline_changes.length > 0 || run.nudge_evaluated || run.error);
  if (runs.length === 0) {
    await ctx.channel.send(msg.chatId, { text: `最近 ${days} 天暂无 storyline changes` });
  } else {
    await ctx.channel.send(msg.chatId, {
      card: renderDailyMemoryRunsCard(runs, { expandedIndex: 0 }),
    });
  }
  return { handled: true };
}

async function handleSchedules(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const config = loadSchedulesConfig();
  await ctx.channel.send(msg.chatId, {
    card: renderSchedulesCard(config),
  });
  return { handled: true };
}

export function renderSchedulesCard(config: SchedulesConfig): object {
  const actionNonce = Date.now().toString(36);
  const elements: object[] = [
    { tag: "markdown", content: "**定时任务**" },
  ];

  for (const schedule of config.schedules) {
    const status = schedule.enabled ? "启用" : "停用";
    const trigger = schedule.cron ?? "manual";
    const profile = schedule.kind === "agent"
      ? `\n档位：${schedule.profile?.trim() || "normal"}`
      : "";
    elements.push({
      tag: "markdown",
      content: `**${schedule.name}** \`${schedule.id}\`\n${schedule.kind} · ${trigger}${profile}\n状态：${status}`,
    });
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "auto",
          elements: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: schedule.enabled ? "停用" : "启用",
              },
              type: schedule.enabled ? "default" : "primary",
              width: "default",
              behaviors: [
                {
                  type: "callback",
                  value: {
                    action: "toggle_schedule",
                    schedule_id: schedule.id,
                    enabled: !schedule.enabled,
                    nonce: actionNonce,
                  },
                },
              ],
            },
          ],
        },
        {
          tag: "column",
          width: "auto",
          elements: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: "立刻运行",
              },
              type: "default",
              width: "default",
              behaviors: [
                {
                  type: "callback",
                  value: {
                    action: "run_schedule",
                    schedule_id: schedule.id,
                    nonce: actionNonce,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  }

  return {
    schema: "2.0",
    body: { elements },
  };
}

async function handleConsolidate(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.channel.send(msg.chatId, { text: "⏳ 开始手动合并…" });
  // 由 schedule 层的 consolidation 逻辑处理
  const { runConsolidation } = await import("../memory/consolidation.js");
  await runConsolidation(ctx.db, ctx.agentService, ctx.channel, ctx.registry);
  return { handled: true };
}
