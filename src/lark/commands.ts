import type { LarkChannel, NormalizedMessage } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { ChatRegistry } from "./chatRegistry.js";
import type { HarnessManager } from "../agent/harness.js";

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

const HELP_TEXT = `**可用命令**

/help - 查看命令列表
/new-diary-group - 创建一个日记群
/new - 重置当前会话
/compact - 压缩当前会话上下文
/profile - 查看身份画像
/profile add <new_text> - 添加身份画像
/profile remove <old_text> - 删除身份画像中的唯一子串
/profile replace <old_text> => <new_text> - 替换身份画像中的唯一子串
/working - 查看工作集
/consolidate - 手动触发周度合并`;

export async function handleCommand(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const text = msg.content.trim();
  if (!text.startsWith("/")) return { handled: false };

  const [cmd, ...args] = text.split(/\s+/);

  switch (cmd) {
    case "/help":
      return handleHelp(msg, ctx);
    case "/new-diary-group":
      return handleNewDiaryGroup(msg, ctx);
    case "/new":
      return handleNew(msg, ctx);
    case "/compact":
      return handleCompact(msg, ctx);
    case "/profile":
      return handleProfile(msg, ctx);
    case "/working":
      return handleWorking(msg, ctx);
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
  await ctx.channel.send(msg.chatId, { markdown: HELP_TEXT });
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

async function handleNew(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  await ctx.harnessManager.resetSession(msg.chatId);
  await ctx.channel.send(msg.chatId, { text: "🔄 会话已重置" });
  return { handled: true };
}

async function handleCompact(
  msg: NormalizedMessage,
  ctx: CommandContext,
): Promise<CommandResult> {
  const entry = await ctx.harnessManager.getOrCreate(msg.chatId, "diary");
  await entry.harness.compact();
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
      markdown: `**📋 身份画像**\n\n${profile}`,
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
    text: "用法：/profile | /profile add <new_text> | /profile remove <old_text> | /profile replace <old_text> => <new_text>",
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
  const items = ctx.harnessManager.getMemoryService().getAllWorkingItems();
  if (items.length === 0) {
    await ctx.channel.send(msg.chatId, { text: "工作集为空" });
    return { handled: true };
  }
  const text = items
    .map((item) => {
      const status =
        item.status === "active"
          ? "🟢"
          : item.status === "dormant"
            ? "💤"
            : item.status === "done"
              ? "✅"
              : "❌";
      return `${status} **${item.name}**（${item.type}）\n${item.thesis ?? ""}`;
    })
    .join("\n\n");
  await ctx.channel.send(msg.chatId, { markdown: `**📋 工作集**\n\n${text}` });
  return { handled: true };
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
