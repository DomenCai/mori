import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import type { HarnessManager } from "../agent/harness.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { DiaryService } from "../diary/service.js";
import { genId, nowISO, weekKey } from "../utils.js";

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
    console.log("[consolidation] 本周无 episode，跳过");
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
   - 活跃项目/问题的当前状态、下一步、决策据本周 episode 更新（调用 upsert_working_item）
   - 长期未被提及的项目转为 dormant
   - 新出现的项目/关注点新建条目

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
  });

  try {
    await entry.harness.prompt(prompt);

    if (summaryText) {
      const wk = weekKey();
      db.prepare(
        "INSERT OR REPLACE INTO weekly_summaries (id, week_key, summary, created_at) VALUES (?, ?, ?, ?)",
      ).run(genId("ws"), wk, summaryText, nowISO());

      const diaryChats = registry.getDiaryChats();
      for (const chatId of diaryChats) {
        await channel.send(chatId, {
          markdown: `**📊 本周总结（${wk}）**\n\n${summaryText}`,
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
    unsubscribe();
    await harnessManager.resetSession(scopeId);
  }
}
