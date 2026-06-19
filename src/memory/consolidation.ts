import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import type { HarnessManager } from "../agent/harness.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { DiaryService } from "../diary/service.js";
import { MemoryService } from "./service.js";
import { genId, nowISO, weekKey } from "../utils.js";
import { logger } from "../log.js";
import { renderApprovalCard, renderWeeklyRecordCard, renderWeeklyFriendCard } from "../lark/cards.js";
import { MessageService } from "../storage/messages.js";

const log = logger("consolidation");

export async function runConsolidation(
  db: Database.Database,
  harnessManager: HarnessManager,
  channel: LarkChannel,
  registry: ChatRegistry,
): Promise<void> {
  const diaryService = new DiaryService(db);
  const memoryService = new MemoryService(db);

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const episodes = diaryService.getEpisodesSince(weekStart.toISOString());

  if (episodes.length === 0) {
    log.info("本周无 episode，跳过");
    return;
  }

  const runId = genId("run");
  const scopeId = `consolidation_${runId}`;

  const entry = await harnessManager.getOrCreate(scopeId, "consolidation", {
    runId,
  });

  const episodeSummaries = episodes
    .map((ep) => {
      const transcript = buildEpisodeTranscript(
        diaryService.getSourceMessagesForEpisode(ep as any),
      );
      return `[${ep.occurred_at}] ${ep.brief}\n${ep.analysis_json}${
        transcript ? `\n原文：\n${transcript}` : ""
      }`;
    })
    .join("\n\n---\n\n");

  const mechanicalPrompt = `# 周度合并：整理与更新

以下是本周的所有 episode（共 ${episodes.length} 条）：

${episodeSummaries}

请完成两件事：

1. **增量更新工作集**：
   - 新出现的项目/关注点调用 create_working_item
   - 更新已有项目必须使用工作集 snapshot 中的 id 调 update_working_item
   - 长期未被提及的项目转为 dormant 属于高影响变更，会自动进入审批
   - 重复或高度重叠的工作集调用 merge_working_items 提出合并审批

2. **保守更新身份画像**：
   - 仅当出现**跨篇稳定、反复出现**的信号时才修改画像（调用 update_profile）
   - 不因单篇内容或一时情绪改画像
   - 原文里只有 \`user:\` 的内容可作为画像证据；\`assistant:\` 是你自己说过的话，仅供理解上下文，绝不可作为画像证据
   - 每次改动说明原因

做完工具调用后，用三五句**客观、不带情绪**的话记一笔这周客观发生了什么——这是给周报存档的事实梳理，先别抒情、别写寄语。`;

  const friendPrompt = `现在脱下分析的帽子。

你不是在写周报——你就是 soul 里那个很懂我的朋友，刚把我这一整周看完了。跟我说几句话：挑一两件你真正想说的（一个你注意到的模式、一个想点破的盲点、或者一句真心话），别复盘我这周做了什么、我自己清楚。按你一贯的语气，几句话就够。

这一轮只说话，不要调用任何工具。`;

  let captured = "";

  const unsubscribe = entry.harness.subscribe(async (event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      captured += event.assistantMessageEvent.delta;
    }
    if (event.type === "tool_execution_end") {
      await sendApprovalCardIfNeeded(
        event.result,
        db,
        channel,
        registry,
        harnessManager,
      );
    }
  });

  let finalizedWorkingUpdates = false;
  const runStartIso = nowISO();
  const wk = weekKey();
  const diaryChats = registry.getDiaryChats();
  const messageService = new MessageService(db);
  try {
    // 第一轮（机械 + 客观梳理）：更新工作集/画像，最后给一段事实记录。
    captured = "";
    await entry.harness.prompt(mechanicalPrompt);
    const recapText = captured.trim();
    finalizedWorkingUpdates = true;

    const approvalIds =
      harnessManager.finalizeConsolidationWorkingItemUpdates(runId);
    for (const approvalId of approvalIds) {
      await sendApprovalCardById(
        approvalId,
        db,
        channel,
        registry,
        harnessManager,
      );
    }

    const profileChanges = memoryService
      .getProfileRevisionsByRun(runId)
      .map((r) => ({
        reason: r.reason,
        delta: summarizeProfileDelta(r.old_content, r.new_content),
      }));
    const workingChanges = memoryService.getWorkingItemsTouchedSince(runStartIso);

    const recordCard = renderWeeklyRecordCard({
      weekKey: wk,
      recap: recapText,
      profileChanges,
      workingChanges,
    });
    const recordText = buildWeeklyRecordText(
      recapText,
      profileChanges,
      workingChanges,
    );
    for (const chatId of diaryChats) {
      const sent = await channel.send(chatId, { card: recordCard });
      messageService.saveAssistantMessage({
        id: sent.messageId,
        chatId,
        content: `本周记录（${wk}）\n\n${recordText}`,
      });
    }

    const saveWeeklySummary = (text: string) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO weekly_summaries (id, week_key, summary, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(genId("ws"), wk, text, nowISO());

    // 机械更新和记录卡已经落地，这是耐久的核心：先存档 + 记 completed，不让后面的朋友轮拖累它。
    saveWeeklySummary(recordText);
    db.prepare(
      `INSERT INTO agent_runs (id, scope_id, command, model, tool_calls_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      scopeId,
      "weekly_consolidation",
      entry.modelId,
      "[]",
      "completed",
      nowISO(),
    );

    // 第二轮（朋友）：脱下帽子说几句，纯生成。锦上添花，失败不影响已落地的一切。
    try {
      captured = "";
      await entry.harness.setActiveTools([]);
      await entry.harness.prompt(friendPrompt);
      const friendText = captured.trim();
      if (friendText) {
        const friendCard = renderWeeklyFriendCard(friendText);
        for (const chatId of diaryChats) {
          const sent = await channel.send(chatId, { card: friendCard });
          messageService.saveAssistantMessage({
            id: sent.messageId,
            chatId,
            content: friendText,
          });
        }
        saveWeeklySummary(`${friendText}\n\n--- 本周记录 ---\n\n${recordText}`);
      }
    } catch (err) {
      log.warn(`朋友轮失败，已保留本周记录：${err}`);
    }
  } finally {
    if (!finalizedWorkingUpdates) {
      harnessManager.discardConsolidationWorkingItemUpdates(runId);
    }
    unsubscribe();
    await harnessManager.resetSession(scopeId);
  }
}

async function sendApprovalCardIfNeeded(
  result: unknown,
  db: Database.Database,
  channel: LarkChannel,
  registry: ChatRegistry,
  harnessManager: HarnessManager,
): Promise<void> {
  const approvalId = extractApprovalId(result);
  if (!approvalId) return;
  await sendApprovalCardById(approvalId, db, channel, registry, harnessManager);
}

async function sendApprovalCardById(
  approvalId: string,
  db: Database.Database,
  channel: LarkChannel,
  registry: ChatRegistry,
  harnessManager: HarnessManager,
): Promise<void> {
  const approvalService = harnessManager.getApprovalService();
  const approval = approvalService.get(approvalId);
  if (!approval) return;
  const payload = approvalService.parsePayload(approval);
  const messageService = new MessageService(db);
  for (const chatId of registry.getDiaryChats()) {
    const sent = await channel.send(chatId, {
      card: renderApprovalCard(approvalId, payload),
    });
    approvalService.attachMessage(approvalId, chatId, sent.messageId);
    messageService.saveAssistantMessage({
      id: sent.messageId,
      chatId,
      content: `工作集变更审批：${approvalId}`,
    });
  }
}

function extractApprovalId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const approvalId = (details as { approvalId?: unknown }).approvalId;
  return typeof approvalId === "string" ? approvalId : null;
}

const MAX_EPISODE_TRANSCRIPT_CHARS = 2000;

// 回读原文做画像保真，但要有预算：超长的对话片段截断，episode 的 brief+observations 始终保留。
function buildEpisodeTranscript(
  messages: Array<{ role: string; content: string }>,
): string {
  const full = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  if (full.length <= MAX_EPISODE_TRANSCRIPT_CHARS) return full;
  return `${full.slice(0, MAX_EPISODE_TRANSCRIPT_CHARS)}\n…（原文过长已截断，完整内容可 search_diary 回查）`;
}

// 画像是一段文本，update_profile 的 add/replace/remove 都体现为子串变化。
// 掐掉公共前后缀，留下真正变动的中间段，让用户看到“改了哪句”而不只是“改了”。
function summarizeProfileDelta(oldText: string, newText: string): string {
  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < oldText.length - p &&
    s < newText.length - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  ) {
    s++;
  }
  const removed = oldText.slice(p, oldText.length - s).trim();
  const added = newText.slice(p, newText.length - s).trim();
  const clip = (t: string) => (t.length > 80 ? `${t.slice(0, 80)}…` : t);
  if (removed && added) return `「${clip(removed)}」→「${clip(added)}」`;
  if (added) return `＋ ${clip(added)}`;
  if (removed) return `－ ${clip(removed)}`;
  return "（无文本变化）";
}

// 记录卡 / 存档用的纯文本版：客观梳理 + 画像变更 + 工作集变更，让历史和检索仍能命中。
function buildWeeklyRecordText(
  recap: string,
  profileChanges: Array<{ reason: string; delta: string }>,
  workingChanges: Array<{ name: string; status: string; isNew: boolean }>,
): string {
  const parts = [recap.trim()];
  if (profileChanges.length > 0) {
    parts.push(
      `🧠 身份画像变更（${profileChanges.length}）\n` +
        profileChanges.map((c) => `- ${c.reason}\n  ${c.delta}`).join("\n"),
    );
  }
  if (workingChanges.length > 0) {
    parts.push(
      `📌 工作集变更（${workingChanges.length}）\n` +
        workingChanges
          .map((c) => `- ${c.isNew ? "新建" : "更新"} ${c.name} → ${c.status}`)
          .join("\n"),
    );
  }
  return parts.join("\n\n");
}
