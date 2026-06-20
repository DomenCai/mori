import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import type { HarnessManager } from "../agent/harness.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import type { MutableClock } from "../clock.js";
import { type StorylineChangeSummary } from "./service.js";
import { genId, shanghaiDateKey, summarizeTextDelta, weekKey } from "../utils.js";
import { logger } from "../log.js";
import { renderWeeklyRecordCard, renderWeeklyFriendCard } from "../lark/cards.js";
import { larkChatConversationId, larkMessageId } from "../lark/ingest.js";

const log = logger("consolidation");
const MAX_EPISODE_TRANSCRIPT_CHARS = 2000;

export async function runConsolidation(
  db: Database.Database,
  harnessManager: HarnessManager,
  channel: LarkChannel,
  registry: ChatRegistry,
  since?: string,
): Promise<void> {
  const now = harnessManager.getClock().now();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const sinceIso = since ?? weekStart.toISOString();
  await runWeeklyConsolidationForWindow({
    db,
    harnessManager,
    channel,
    registry,
    since: sinceIso,
    until: now.toISOString(),
    sendCards: true,
    friendRound: true,
  });
}

export async function runWeeklyConsolidationForWindow(opts: {
  db: Database.Database;
  harnessManager: HarnessManager;
  since: string;
  until: string;
  clock?: MutableClock;
  channel?: LarkChannel;
  registry?: ChatRegistry;
  sendCards: boolean;
  friendRound: boolean;
}): Promise<void> {
  const {
    db,
    harnessManager,
    since,
    until,
    clock,
    channel,
    registry,
    sendCards,
    friendRound,
  } = opts;

  if (clock) {
    clock.set(new Date(new Date(until).getTime() - 5 * 60_000));
  }

  const diaryService = harnessManager.getDiaryService();
  const memoryService = harnessManager.getMemoryService();
  const episodes = diaryService.getEpisodesInWindow(since, until);
  const sinceDateKey = shanghaiDateKey(new Date(since));
  const untilDateKey = shanghaiDateKey(new Date(until));
  const dailyRuns = memoryService.getDailyMemoryRunsInDateRange(
    sinceDateKey,
    untilDateKey,
  );
  const storylineChanges = dedupeStorylineChanges([
    ...memoryService.getStorylineChangesInWindow(since, until),
    ...memoryService.getStorylineChangesByRuns(dailyRuns.map((run) => run.id)),
  ]);

  if (episodes.length === 0 && dailyRuns.length === 0 && storylineChanges.length === 0) {
    log.info("本周无 memory 信号，跳过");
    return;
  }

  const runId = genId("run");
  const scopeId = `consolidation_${runId}`;
  const entry = await harnessManager.getOrCreate(scopeId, "consolidation", {
    runId,
  });

  const episodeSummaries = episodes
    .map((ep) => {
      const transcript = buildUserEpisodeTranscript(
        diaryService.getSourceMessagesForEpisode(ep as any),
      );
      return `[${ep.occurred_at}] ${ep.id} ${ep.brief}\n${ep.analysis_json}${
        transcript ? `\n用户原文证据：\n${transcript}` : ""
      }`;
    })
    .join("\n\n---\n\n");

  const mechanicalPrompt = `# 周度合并：画像更新与客观记录

你只做两件事：

1. 判断这一周的叙事变化是否应该改变长期身份画像，必要时调用 update_profile。
2. 用三五句客观、不带情绪的话记一笔这周发生了什么，作为周记录正文。

边界：
- 允许 update_profile；禁止写 storylines，storylines 是 daily_memory 的职责。
- 画像变更必须有用户证据，不能只基于 daily run 或 storyline 二次总结。
- 只有 \`user:\` 原文可作为画像证据；assistant 内容绝不可作为画像证据。
- 仅当出现跨篇稳定、反复出现的信号时才修改画像；不因单篇内容或一时情绪改画像。
- 如 episode evidence 不足，可用 search_memory 回查原文。

本周 daily_memory runs：
\`\`\`json
${JSON.stringify(dailyRuns, null, 2)}
\`\`\`

本周 touched storylines：
\`\`\`json
${JSON.stringify(storylineChanges, null, 2)}
\`\`\`

本周 episodes（共 ${episodes.length} 条）：
${episodeSummaries || "（无 episode）"}

当前 profile：
${memoryService.getProfile()}

做完必要工具调用后，直接输出周记录正文。`;

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
      captured = "";
    }
  });

  const wk = weekKey(new Date(since));
  const diaryChats = sendCards ? registry?.getDiaryChats() ?? [] : [];
  const messageService = harnessManager.getMessageService();
  try {
    captured = "";
    await entry.harness.setActiveTools(["update_profile", "search_memory"]);
    await entry.harness.prompt(mechanicalPrompt);
    const recapText = captured.trim();

    const profileChanges = memoryService
      .getProfileRevisionsByRun(runId)
      .map((r) => ({
        reason: r.reason,
        delta: summarizeTextDelta(r.old_content, r.new_content),
      }));

    const recordText = buildWeeklyRecordText(
      recapText,
      profileChanges,
      storylineChanges,
    );
    if (sendCards) {
      if (!channel || !registry) {
        throw new Error("sendCards=true 需要 channel 和 registry");
      }
      const recordCard = renderWeeklyRecordCard({
        weekKey: wk,
        recap: recapText,
        profileChanges,
        storylineChanges: compactStorylineChanges(storylineChanges),
      });
      for (const chatId of diaryChats) {
        const sent = await channel.send(chatId, { card: recordCard });
        messageService.saveAssistantMessage({
          id: larkMessageId(sent.messageId)!,
          source: "lark",
          conversationId: larkChatConversationId(chatId),
          conversationType: "diary",
          content: `本周记录（${wk}）\n\n${recordText}`,
        });
      }
    }

    const saveWeeklySummary = (text: string) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO weekly_summaries (id, week_key, summary, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(genId("ws"), wk, text, harnessManager.getClock().nowISO());

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
      harnessManager.getClock().nowISO(),
    );

    if (friendRound) {
      try {
        captured = "";
        await entry.harness.setActiveTools([]);
        await entry.harness.prompt(friendPrompt);
        const friendText = captured.trim();
        if (friendText) {
          if (sendCards && channel) {
            const friendCard = renderWeeklyFriendCard(friendText);
            for (const chatId of diaryChats) {
              const sent = await channel.send(chatId, { card: friendCard });
              messageService.saveAssistantMessage({
                id: larkMessageId(sent.messageId)!,
                source: "lark",
                conversationId: larkChatConversationId(chatId),
                conversationType: "diary",
                content: friendText,
              });
            }
          }
          saveWeeklySummary(`${friendText}\n\n--- 本周记录 ---\n\n${recordText}`);
        }
      } catch (err) {
        log.warn(`朋友轮失败，已保留本周记录：${err}`);
      }
    }
  } finally {
    unsubscribe();
    await harnessManager.resetSession(scopeId);
  }
}

function dedupeStorylineChanges(
  changes: StorylineChangeSummary[],
): StorylineChangeSummary[] {
  const seen = new Set<string>();
  const result: StorylineChangeSummary[] = [];
  for (const change of changes) {
    const key = `${change.id}:${change.operation}:${change.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(change);
  }
  return result;
}

function buildUserEpisodeTranscript(
  messages: Array<{ role: string; content: string }>,
): string {
  const full = messages
    .filter((m) => m.role === "user")
    .map((m) => `user: ${m.content}`)
    .join("\n");
  if (full.length <= MAX_EPISODE_TRANSCRIPT_CHARS) return full;
  return `${full.slice(0, MAX_EPISODE_TRANSCRIPT_CHARS)}\n…（用户原文过长已截断，完整内容可 search_memory 回查）`;
}

function compactStorylineChanges(
  changes: StorylineChangeSummary[],
): Array<{ title: string; operation: string; status: string; reason: string }> {
  return changes.map((change) => ({
    title: change.title,
    operation: change.operation,
    status: change.status,
    reason: change.reason,
  }));
}

function buildWeeklyRecordText(
  recap: string,
  profileChanges: Array<{ reason: string; delta: string }>,
  storylineChanges: StorylineChangeSummary[],
): string {
  const parts = [recap.trim()];
  if (storylineChanges.length > 0) {
    parts.push(
      `📌 叙事线索变化（${storylineChanges.length}）\n` +
        storylineChanges
          .map((c) => `- ${c.operation} ${c.title} → ${c.status}（${c.reason}）`)
          .join("\n"),
    );
  }
  if (profileChanges.length > 0) {
    parts.push(
      `🧠 身份画像变更（${profileChanges.length}）\n` +
        profileChanges.map((c) => `- ${c.reason}\n  ${c.delta}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}
