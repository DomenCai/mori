import type { LarkChannel, NormalizedMessage } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { ChatRegistry } from "./chatRegistry.js";
import type { HarnessManager } from "../agent/harness.js";
import { larkConversationId } from "./ingest.js";
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

export interface CommandContext {
  channel: LarkChannel;
  db: Database.Database;
  registry: ChatRegistry;
  harnessManager: HarnessManager;
  ownerOpenId: string;
}

interface CommandResult {
  handled: boolean;
}

function helpText(): string {
  return `**<font color='wathet'>/think <内容></font>** - 顺着为什么往下钻；也可回复一条消息使用
**<font color='wathet'>/rank <内容></font>** - 把一个领域砍到两三根生成器；也可回复一条消息使用
**<font color='wathet'>/plain <内容></font>** - 用大白话讲到能复述；也可回复一条消息使用
**<font color='wathet'>/new-diary-group</font>** - 创建一个日记群
**<font color='wathet'>/new-chat <主题></font>** - 创建一个持续主题群
**<font color='wathet'>/new</font>** - 重置当前会话
**<font color='wathet'>/compact</font>** - 压缩当前会话上下文
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
    case "/new-chat":
      return handleNewChat(msg, ctx, args.join(" "));
    case "/new":
      return handleNew(msg, ctx);
    case "/compact":
      return handleCompact(msg, ctx);
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
  await ctx.harnessManager.resetSession(larkConversationId(msg));
  await ctx.channel.send(msg.chatId, { text: "🔄 会话已重置" });
  return { handled: true };
}

async function handleCompact(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.harnessManager.compactSession(larkConversationId(msg));
  await ctx.channel.send(msg.chatId, { text: "📦 上下文已压缩" });
  return { handled: true };
}

async function handleProfile(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const rest = msg.content.trim().slice("/profile".length).trim();
  const memory = ctx.harnessManager.getMemoryService();
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
  const memory = ctx.harnessManager.getMemoryService();
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
  const items = ctx.harnessManager.getMemoryService().getVisibleStorylines();
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
  const memory = ctx.harnessManager.getMemoryService();
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
  const memory = ctx.harnessManager.getMemoryService();
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
    const trigger = schedule.cron
      ? schedule.cron
      : schedule.trigger
        ? JSON.stringify(schedule.trigger)
        : "manual";
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
  await runConsolidation(ctx.db, ctx.harnessManager, ctx.channel, ctx.registry);
  return { handled: true };
}
