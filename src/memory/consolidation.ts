import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import type { HarnessManager } from "../agent/harness.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { DiaryService } from "../diary/service.js";
import { genId, nowISO, weekKey } from "../utils.js";
import { logger } from "../log.js";
import { renderApprovalCard } from "../lark/cards.js";
import { MessageService } from "../storage/messages.js";

const log = logger("consolidation");

export async function runConsolidation(
  db: Database.Database,
  harnessManager: HarnessManager,
  channel: LarkChannel,
  registry: ChatRegistry,
): Promise<void> {
  const diaryService = new DiaryService(db);

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
    .map(
      (ep) =>
        `[${ep.occurred_at}] ${ep.brief}\n${ep.analysis_json}`,
    )
    .join("\n\n---\n\n");

  const prompt = `# 周度合并任务

以下是本周的所有 episode（共 ${episodes.length} 条）：

${episodeSummaries}

请完成以下任务：

1. **增量更新工作集**：
   - 新出现的项目/关注点调用 create_working_item
   - 更新已有项目必须使用工作集 snapshot 中的 id 调 update_working_item
   - 长期未被提及的项目转为 dormant 属于高影响变更，会自动进入审批
   - 重复或高度重叠的工作集调用 merge_working_items 提出合并审批

2. **保守更新身份画像**：
   - 仅当出现**跨篇稳定、反复出现**的信号时才修改画像（调用 update_profile）
   - 不因单篇内容或一时情绪改画像
   - 每次改动说明原因

3. **写周总结**：
   - 用自然的中文，像朋友回顾这一周
   - 点出关键进展、值得关注的变化、可能的盲点
   - 不要写成模板报告`;

  let summaryText = "";

  const unsubscribe = entry.harness.subscribe(async (event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      summaryText += event.assistantMessageEvent.delta;
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
  try {
    await entry.harness.prompt(prompt);
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

    if (summaryText) {
      const wk = weekKey();
      db.prepare(
        "INSERT OR REPLACE INTO weekly_summaries (id, week_key, summary, created_at) VALUES (?, ?, ?, ?)",
      ).run(genId("ws"), wk, summaryText, nowISO());

      const diaryChats = registry.getDiaryChats();
      const messageService = new MessageService(db);
      for (const chatId of diaryChats) {
        const sent = await channel.send(chatId, {
          markdown: `**📊 本周总结（${wk}）**\n\n${summaryText}`,
        });
        messageService.saveAssistantMessage({
          id: sent.messageId,
          chatId,
          content: `本周总结（${wk}）\n\n${summaryText}`,
        });
      }
    }

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
