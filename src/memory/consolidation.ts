import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import type { AgentService } from "../agent/index.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import type { MutableClock } from "../clock.js";
import { type StorylineChangeSummary } from "./service.js";
import { genId, businessDateKey, textLineChanges, weekKey } from "../utils.js";
import { logger } from "../log.js";
import { larkCardToText } from "../lark/cardText.js";
import { renderWeeklyRecordCard, renderMarkdownCard } from "../lark/cards.js";
import { larkChatConversationId, larkMessageId } from "../lark/ingest.js";

const log = logger("consolidation");
const MAX_EPISODE_TRANSCRIPT_CHARS = 2000;

export async function runConsolidation(
  db: Database.Database,
  agentService: AgentService,
  channel: LarkChannel,
  registry: ChatRegistry,
  since?: string,
): Promise<void> {
  const now = agentService.getClock().now();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const sinceIso = since ?? weekStart.toISOString();
  await runWeeklyConsolidationForWindow({
    db,
    agentService,
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
  agentService: AgentService;
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
    agentService,
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

  const diaryService = agentService.getDiaryService();
  const memoryService = agentService.getMemoryService();
  const episodes = diaryService.getEpisodesInWindow(since, until);
  const sinceDateKey = businessDateKey(new Date(since));
  const untilDateKey = businessDateKey(new Date(until));
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
  const currentChapter = memoryService.getChapter();
  const currentVisibleStorylines = memoryService.getVisibleStorylines();

  const mechanicalPrompt = `# 周度合并：画像更新、当前主线与客观记录

你只做三件事：

1. 判断这一周的叙事变化是否应该改变长期身份画像，必要时调用 update_profile。
2. 判断当前主线是否需要刷新，必要时调用 set_chapter。
3. 用三五句客观、不带情绪的话记一笔这周发生了什么，作为周记录正文。

边界：
- 允许 update_profile 和 set_chapter；禁止写 storylines，storylines 是 daily_memory 的职责。
- 画像变更必须有用户证据，不能只基于 daily run 或 storyline 二次总结。
- 只有 \`user:\` 原文可作为画像证据；assistant 内容绝不可作为画像证据。
- 仅当出现跨篇稳定、反复出现的信号时才修改画像；不因单篇内容或一时情绪改画像。
- 如 episode evidence 不足，可用 search_memory 回查原文。
- 输入分区：当前 visible storylines 和当前 chapter 只供刷新当前主线使用，不能放宽画像门控；画像只凭本周新鲜用户证据判断。

刷新当前主线：
- 当前主线是 profile 与 storylines 之间的中间层，写此刻横跨多条 storyline 的阶段、主题或反复卡点。
- 默认延续原 chapter；只有主线真的转章、变清楚或原文已不准时才调用 set_chapter。
- content 最多 400 到 500 字，写成一段连接性 prose，不要 bullet，不复述单条 storyline。
- 描述处境与主题，不下心理状态、人格、关系或健康结论，不写未经确认的敏感推断。
- source_storyline_ids 是主证据，必须来自 currentVisibleStorylines；source_episode_ids 只是可选原文锚点。

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

当前 chapter：
${currentChapter || "（尚未建立当前主线）"}

currentVisibleStorylines（只供刷新当前主线）：
\`\`\`json
${JSON.stringify(currentVisibleStorylines, null, 2)}
\`\`\`

做完必要工具调用后，最终回复必须严格使用下面格式：
<weekly_record>
三五句客观周记录正文
</weekly_record>

标签外不要写任何内容。标签内只写周记录正文；不要写画像评估、推理过程、结论说明或工具调用说明。`;

  const wk = weekKey(new Date(since));
  const diaryChats = sendCards ? registry?.getDiaryChats() ?? [] : [];
  const messageService = agentService.getMessageService();

  // captured 是主轮 prompt 的最终段文本（每次 tool_execution_end 重置一次）；
  // 业务侧再用 <weekly_record> 标签提取周记录正文。
  const mainResult = await agentService.runConsolidationMain(mechanicalPrompt, {
    runId,
    defaultTools: ["search_memory"],
  });
  const captured = mainResult.text;
  const recapText = extractWeeklyRecap(captured);

  const profileChanges = memoryService
    .getProfileRevisionsByRun(runId)
    .map((r) => ({
      reason: r.reason,
      delta: formatLineChangeCounts(r.old_content, r.new_content),
    }));

  const recordCard = renderWeeklyRecordCard({
    weekKey: wk,
    recap: recapText,
    profileChanges,
    storylineChanges: compactStorylineChanges(storylineChanges),
  });
  const recordText = larkCardToText(recordCard);
  if (sendCards) {
    if (!channel || !registry) {
      throw new Error("sendCards=true 需要 channel 和 registry");
    }
    for (const chatId of diaryChats) {
      const sent = await channel.send(chatId, { card: recordCard });
      messageService.saveAssistantMessage({
        id: larkMessageId(sent.messageId)!,
        source: "lark",
        conversationId: larkChatConversationId(chatId),
        conversationType: "diary",
        content: recordText,
      });
    }
  }

  db.prepare(
    "INSERT OR REPLACE INTO weekly_summaries (id, week_key, summary, friend_note, created_at) VALUES (?, ?, ?, NULL, ?)",
  ).run(genId("ws"), wk, recordText, agentService.getClock().nowISO());
  db.prepare(
    `INSERT INTO agent_runs (id, scope_id, command, model, tool_calls_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    `consolidation_${runId}`,
    "weekly_consolidation",
    mainResult.modelId,
    "[]",
    "completed",
    agentService.getClock().nowISO(),
  );

  if (friendRound) {
    await runFriendAgent({
      agentService,
      db,
      episodes,
      wk,
      runId,
      channel,
      diaryChats,
      sendCards,
      memoryService,
    });
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

function formatLineChangeCounts(oldText: string, newText: string): string {
  const changes = textLineChanges(oldText, newText);
  return `+${changes.added.length}/-${changes.removed.length}`;
}

function extractWeeklyRecap(raw: string): string {
  const text = raw.trim();
  const tagMatch = /<weekly_record>\s*([\s\S]*?)\s*<\/weekly_record>/i.exec(text);
  if (tagMatch) return tagMatch[1].trim();

  const headings = [
    /(?:^|\n)\s*(?:---\s*)?\s*(?:#{1,6}\s*)?(?:\*\*)?周记录（[^）]+）[:：]?(?:\*\*)?\s*\n+/g,
    /(?:^|\n)\s*(?:---\s*)?\s*(?:#{1,6}\s*)?(?:\*\*)?周记录[^:\n：]*[:：](?:\*\*)?\s*/g,
    /(?:^|\n)\s*(?:---\s*)?\s*(?:#{1,6}\s*)?(?:\*\*)?(?:周记录正文|客观记录正文)[:：](?:\*\*)?\s*/g,
  ];
  let lastMatch: RegExpExecArray | null = null;
  for (const heading of headings) {
    let match: RegExpExecArray | null;
    while ((match = heading.exec(text)) !== null) {
      if (!lastMatch || match.index > lastMatch.index) {
        lastMatch = match;
      }
    }
  }
  if (!lastMatch) return text;
  return text.slice(lastMatch.index + lastMatch[0].length).trim();
}

async function runFriendAgent(opts: {
  agentService: AgentService;
  db: Database.Database;
  episodes: Array<Record<string, any>>;
  wk: string;
  runId: string;
  channel?: LarkChannel;
  diaryChats: string[];
  sendCards: boolean;
  memoryService: import("./service.js").MemoryService;
}): Promise<void> {
  const {
    agentService,
    db,
    episodes,
    wk,
    runId,
    channel,
    diaryChats,
    sendCards,
    memoryService,
  } = opts;
  const diaryService = agentService.getDiaryService();
  const messageService = agentService.getMessageService();
  const weekTranscript = buildWeekUserTranscript(diaryService, episodes);
  const priorNotes = getPriorFriendNotes(db, wk, 4);

  let friendText = "";
  try {
    // friend 轮工具集为空：只说话不调工具。
    friendText = await agentService.runConsolidationFriend(
      buildFriendPrompt(weekTranscript, priorNotes),
      { runId },
    );
  } catch (err) {
    log.warn(`朋友轮失败，已保留本周记录：${err}`);
    return;
  }

  if (!friendText) return;

  if (sendCards && channel) {
    const friendCard = renderMarkdownCard(friendText);
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

  db.prepare(
    "UPDATE weekly_summaries SET friend_note = ? WHERE week_key = ?",
  ).run(friendText, wk);
}

function buildWeekUserTranscript(
  diaryService: ReturnType<AgentService["getDiaryService"]>,
  episodes: Array<Record<string, any>>,
): string {
  const parts = episodes
    .map((ep) => {
      const transcript = buildUserEpisodeTranscript(
        diaryService.getSourceMessagesForEpisode(ep as any),
      );
      return transcript ? `[${ep.occurred_at}]\n${transcript}` : "";
    })
    .filter(Boolean);
  return parts.join("\n\n---\n\n") || "（本周没有原话记录）";
}

function getPriorFriendNotes(
  db: Database.Database,
  wk: string,
  limit: number,
): string {
  const rows = db
    .prepare(
      `SELECT week_key, friend_note FROM weekly_summaries
       WHERE week_key < ? AND friend_note IS NOT NULL
       ORDER BY week_key DESC
       LIMIT ?`,
    )
    .all(wk, limit) as Array<{ week_key: string; friend_note: string }>;
  if (rows.length === 0) return "（还没有更早的周回复）";
  return rows
    .reverse()
    .map((r) => `【${r.week_key}】\n${r.friend_note}`)
    .join("\n\n");
}

function buildFriendPrompt(weekTranscript: string, priorNotes: string): string {
  return `现在脱下分析的帽子。你就是 soul 里那个很懂我的朋友，刚把我这一整周、连着前几周一起看完了。

你站得比每天都高。日常回复只看得见当天，你看得见跨度，这一轮的价值全在这。别复盘我这周干了什么，我自己清楚。去说那些把几周连起来才看得见的东西：这周真正的主线是哪条（底下那条情绪和判断的线，不是事件清单）；有没有反复出现的主题或卡点，前几周也来过的那种，反复出现的多半不是这周的偶发情绪；有没有我自己没看见、或一直在绕开的那条缝，看到就点，别硬找。

可以引具体某句某事来落地你的判断，但落脚是你的读，不是我的流水账。想说多少说多少，该长就长该一句就一句，别为显得有料硬撑长度。按你一贯的语气，像给我写几句话，不像交周报。

本周我写的原话：
${weekTranscript}

前几周我给你看完后你说的话，别和它们重样；如果发现自己又想说同样的话，那本身就值得跟我点出来：
${priorNotes}

这一轮只说话，不调用任何工具。`;
}
