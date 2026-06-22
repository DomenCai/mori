import type { LarkChannel, NormalizedMessage } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { ChatRegistry } from "./chatRegistry.js";
import type { HarnessManager } from "../agent/harness.js";
import { larkConversationId } from "./ingest.js";
import { loadSchedulesConfig, type SchedulesConfig } from "../schedule/config.js";
import { renderInfoCard, renderProfileHistoryCard } from "./cards.js";
import type { DailyMemoryRun } from "../memory/service.js";
import { parseLens } from "./lenses.js";

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

const HELP_TEXT = `/help - 查看命令列表
/think <内容> - 顺着为什么往下钻；也可回复一条消息使用
/rank <内容> - 把一个领域砍到两三根生成器；也可回复一条消息使用
/plain <内容> - 用大白话讲到能复述；也可回复一条消息使用
/new-diary-group - 创建一个日记群
/new-chat <主题> - 创建一个持续主题群
/new - 重置当前会话
/compact - 压缩当前会话上下文
/profile - 查看身份画像
/profile history - 查看画像变更历史
/profile add <new_text> - 添加身份画像
/profile remove <old_text> - 删除身份画像中的唯一子串
/profile replace <old_text> => <new_text> - 替换身份画像中的唯一子串
/storylines - 查看 active + recent dormant 叙事线
/storyline <id> - 查看单条叙事线详情
/storyline close <id> - 手动软关闭叙事线
/storyline reopen <id> - 手动重新激活叙事线
/dream - 查看最近 daily_memory runs
/dream YYYY-MM-DD - 查看某天 daily_memory 详情
/schedules - 查看定时任务配置
/consolidate - 手动触发周度合并`;

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
    case "/storylines":
      return handleStorylines(msg, ctx);
    case "/storyline":
      return handleStoryline(msg, ctx, args);
    case "/dream":
      return handleDream(msg, ctx, args);
    case "/working":
      return handleWorking(msg, ctx);
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
  await ctx.channel.send(msg.chatId, { card: renderInfoCard("命令列表", HELP_TEXT) });
  return { handled: true };
}

async function handleNewDiaryGroup(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const date = new Date().toLocaleDateString("zh-CN");
  const { chatId } = await ctx.channel.createChat({
    name: `日记群 · ${date}`,
    description: "Personal Agent 日记",
    inviteUserIds: [ctx.ownerOpenId],
    userIdType: "open_id",
  });
  ctx.registry.register(chatId, "diary", `日记群 · ${date}`);
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
    description: "Personal Agent 主题群",
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

  if (!rest) {
    const profile = memory.getProfile();
    await ctx.channel.send(msg.chatId, {
      card: renderInfoCard("📋 身份画像", profile),
    });
    return { handled: true };
  }

  if (rest === "history") {
    const rows = ctx.db
      .prepare(
        `SELECT old_content, new_content, reason, created_at
         FROM profile_revisions
         ORDER BY created_at DESC
         LIMIT 10`,
      )
      .all() as Array<{
      old_content: string | null;
      new_content: string;
      reason: string;
      created_at: string;
    }>;
    await ctx.channel.send(msg.chatId, {
      card: renderProfileHistoryCard(rows),
    });
    return { handled: true };
  }

  try {
    if (rest.startsWith("add ")) {
      const newText = rest.slice("add ".length).trim();
      if (!newText) return sendProfileUsage(msg, ctx);
      memory.updateProfile({
        operation: "add",
        new_text: newText,
        reason: "manual_correction",
      });
      await ctx.channel.send(msg.chatId, { text: "✅ 身份画像已添加" });
      return { handled: true };
    }

    if (rest.startsWith("remove ")) {
      const oldText = rest.slice("remove ".length).trim();
      if (!oldText) return sendProfileUsage(msg, ctx);
      memory.updateProfile({
        operation: "remove",
        old_text: oldText,
        reason: "manual_correction",
      });
      await ctx.channel.send(msg.chatId, { text: "✅ 身份画像已删除" });
      return { handled: true };
    }

    if (rest.startsWith("replace ")) {
      const payload = rest.slice("replace ".length).trim();
      const delimiter = payload.indexOf("=>");
      if (delimiter < 0) return sendProfileUsage(msg, ctx);
      const oldText = payload.slice(0, delimiter).trim();
      const newText = payload.slice(delimiter + "=>".length).trim();
      if (!oldText || !newText) return sendProfileUsage(msg, ctx);
      memory.updateProfile({
        operation: "replace",
        old_text: oldText,
        new_text: newText,
        reason: "manual_correction",
      });
      await ctx.channel.send(msg.chatId, { text: "✅ 身份画像已替换" });
      return { handled: true };
    }
  } catch (err) {
    await ctx.channel.send(msg.chatId, {
      text: `画像修改失败：${formatCommandError(err)}`,
    });
    return { handled: true };
  }

  return sendProfileUsage(msg, ctx);
}

async function sendProfileUsage(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.channel.send(msg.chatId, {
    text: "用法：/profile | /profile history | /profile add <new_text> | /profile remove <old_text> | /profile replace <old_text> => <new_text>",
  });
  return { handled: true };
}

function formatCommandError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleWorking(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.channel.send(msg.chatId, {
    text: "工作集已由 storylines 取代。使用 /storylines 查看当前叙事线。",
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
  const text = items
    .map((item) => {
      const status = item.status === "active" ? "🟢" : item.status === "dormant" ? "💤" : "✅";
      return [
        `${status} **${item.title}**（${item.kind}）`,
        `ID: \`${item.id}\` · last_active_at: ${item.last_active_at}`,
        item.summary,
        item.current_tension ? `当前张力：${item.current_tension}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
  await ctx.channel.send(msg.chatId, { card: renderInfoCard("📋 Storylines", text) });
  return { handled: true };
}

async function handleStoryline(
  msg: NormalizedMessage,
  ctx: CommandContext,
  args: string[],
): Promise<CommandResult> {
  const memory = ctx.harnessManager.getMemoryService();
  const [first, second] = args;
  if (!first) return sendStorylineUsage(msg, ctx);

  if (first === "close" || first === "reopen") {
    if (!second) return sendStorylineUsage(msg, ctx);
    try {
      memory.setStorylineStatus({
        id: second,
        status: first === "close" ? "closed" : "active",
        reason: "manual_correction",
      });
      await ctx.channel.send(msg.chatId, {
        text: first === "close" ? "✅ Storyline 已关闭" : "✅ Storyline 已重新激活",
      });
    } catch (err) {
      await ctx.channel.send(msg.chatId, {
        text: `Storyline 修改失败：${formatCommandError(err)}`,
      });
    }
    return { handled: true };
  }

  const item = memory.getStoryline(first);
  if (!item) {
    await ctx.channel.send(msg.chatId, { text: `storyline 不存在：${first}` });
    return { handled: true };
  }
  const revisions = memory.getStorylineRevisions(first);
  const body = [
    `**${item.title}**（${item.kind} / ${item.status}）`,
    `ID: \`${item.id}\``,
    `last_active_at: ${item.last_active_at}`,
    "",
    item.summary,
    item.current_tension ? `\n**当前张力**\n${item.current_tension}` : "",
    item.emotional_arc ? `\n**情绪/态度弧线**\n${item.emotional_arc}` : "",
    item.people.length ? `\n**相关人**\n${item.people.join("、")}` : "",
    item.evidence_episode_ids.length
      ? `\n**证据 episodes**\n${item.evidence_episode_ids.map((id) => `- ${id}`).join("\n")}`
      : "",
    revisions.length
      ? `\n**最近 revisions**\n${revisions.map((r) => `- ${r.created_at} · ${r.operation} · ${r.reason}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");
  await ctx.channel.send(msg.chatId, { card: renderInfoCard("📋 Storyline", body) });
  return { handled: true };
}

async function sendStorylineUsage(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.channel.send(msg.chatId, {
    text: "用法：/storyline <id> | /storyline close <id> | /storyline reopen <id>",
  });
  return { handled: true };
}

async function handleDream(
  msg: NormalizedMessage,
  ctx: CommandContext,
  args: string[],
): Promise<CommandResult> {
  const memory = ctx.harnessManager.getMemoryService();
  const dateKey = args[0];
  if (dateKey) {
    const run = memory.getDailyMemoryRun(dateKey);
    if (!run) {
      await ctx.channel.send(msg.chatId, { text: `没有 ${dateKey} 的 daily_memory 记录` });
      return { handled: true };
    }
    await ctx.channel.send(msg.chatId, {
      card: renderInfoCard("🌙 Daily Memory", formatDailyRun(run, true)),
    });
    return { handled: true };
  }

  const runs = memory.getRecentDailyMemoryRuns(7);
  if (runs.length === 0) {
    await ctx.channel.send(msg.chatId, { text: "暂无 daily_memory 记录" });
    return { handled: true };
  }
  await ctx.channel.send(msg.chatId, {
    card: renderInfoCard(
      "🌙 Daily Memory",
      runs.map((run) => formatDailyRun(run, false)).join("\n\n---\n\n"),
    ),
  });
  return { handled: true };
}

function formatDailyRun(
  run: DailyMemoryRun,
  verbose: boolean,
): string {
  const lines = [
    `**${run.date_key}** · ${run.status}`,
    `episodes: ${run.input_episode_ids.length} · storyline_changes: ${run.storyline_changes.length} · nudge: ${run.nudge_sent ? "sent" : run.nudge_evaluated ? "evaluated" : "none"}`,
  ];
  if (run.dream_summary) lines.push(`dream: ${run.dream_summary}`);
  if (run.nudge_text) lines.push(`nudge: ${run.nudge_text}`);
  if (run.error) lines.push(`error: ${run.error}`);
  if (verbose && run.storyline_changes.length) {
    lines.push(
      "storyline changes:\n" +
        run.storyline_changes
          .map((c) => `- ${c.operation} ${c.title} → ${c.status}（${c.reason}）`)
          .join("\n"),
    );
  }
  return lines.join("\n");
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
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      background_style: "default",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 3,
          elements: [
            {
              tag: "markdown",
              content: `**${schedule.name}** \`${schedule.id}\`\n${schedule.kind} · ${trigger}\n状态：${status}`,
            },
          ],
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: schedule.enabled ? "停用" : "启用",
              },
              type: schedule.enabled ? "default" : "primary",
              width: "fill",
              behaviors: [
                {
                  type: "callback",
                  value: {
                    action: "toggle_schedule",
                    schedule_id: schedule.id,
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
