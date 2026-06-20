import type Database from "better-sqlite3";
import type { LarkChannel } from "@larksuite/channel";
import type { HarnessManager } from "../agent/harness.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import type { Clock, MutableClock } from "../clock.js";
import { logger } from "../log.js";
import {
  MAX_ACTIVE_STORYLINES,
  MemoryService,
  type StorylineChangeSummary,
  type StorylineRevision,
} from "./service.js";
import {
  previousShanghaiDateKey,
  shanghaiDateRange,
  shanghaiDateStart,
} from "../utils.js";

const log = logger("daily_memory");

export const NUDGE_AFTER_SILENT_DAYS = 3;
export const MIN_NUDGE_INTERVAL_DAYS = 7;

const DREAM_TOOL_NAMES = [
  "search_memory",
  "get_storyline",
  "create_storyline",
  "advance_storyline",
  "set_storyline_status",
  "merge_storylines",
];
const NUDGE_TOOL_NAMES = ["send_checkin"];

export async function runDailyMemory(
  db: Database.Database,
  harnessManager: HarnessManager,
  _channel: LarkChannel,
  registry: ChatRegistry,
): Promise<void> {
  const dateKey = previousShanghaiDateKey(harnessManager.getClock().now());
  await runDailyMemoryForDate({
    db,
    harnessManager,
    registry,
    dateKey,
    nudge: true,
  });
}

export async function runDailyMemoryForDate(opts: {
  db: Database.Database;
  harnessManager: HarnessManager;
  registry?: ChatRegistry;
  dateKey: string;
  clock?: MutableClock;
  nudge: boolean;
}): Promise<void> {
  const { db, harnessManager, registry, dateKey, clock, nudge } = opts;
  if (clock) {
    clock.set(new Date(shanghaiDateStart(dateKey).getTime() + 30 * 60 * 60_000));
  }
  const memoryService = harnessManager.getMemoryService();
  const existing = memoryService.getDailyMemoryRun(dateKey);
  if (existing) {
    log.info(`daily_memory ${dateKey} 已存在，跳过`);
    return;
  }

  const { endIso } = shanghaiDateRange(dateKey);
  const episodes = getUndigestedEpisodesForRun(db, endIso);
  const inputEpisodeIds = episodes.map((episode) => episode.id as string);
  const run = memoryService.createDailyMemoryRun(dateKey, inputEpisodeIds);

  try {
    const decayChanges = memoryService.decayStorylines({
      runId: run.id,
      activeEpisodeIds: inputEpisodeIds,
    });

    let dreamSummary: string | null = null;
    if (episodes.length > 0) {
      dreamSummary = await runDreamAgent(
        harnessManager,
        memoryService,
        run.id,
        dateKey,
        endIso,
        episodes,
      );
      markEpisodesDigested(db, inputEpisodeIds, run.id);
    }

    let nudgeEvaluated = false;
    let nudgeSent = false;
    let nudgeText: string | null = null;
    const nudgeContext = buildNudgeContext(db, memoryService, harnessManager.getClock());
    if (nudge && shouldRunNudgeAgent(memoryService, nudgeContext.silentDays, harnessManager.getClock())) {
      nudgeEvaluated = true;
      const result = await runNudgeAgent(
        harnessManager,
        memoryService,
        run.id,
        dateKey,
        nudgeContext,
      );
      nudgeSent = result.sent;
      nudgeText = result.text;
    } else if (nudge && !registry) {
      log.warn("nudge=true 但未提供 registry，已跳过轻触达");
    }

    const storylineChanges = [
      ...decayChanges,
      ...memoryService
        .getStorylineRevisionsByRun(run.id)
        .map(revisionToChange),
    ];
    const dedupedChanges = dedupeChanges(storylineChanges);
    memoryService.updateDailyMemoryRun(run.id, {
      status: "completed",
      dream_summary: dreamSummary,
      storyline_changes: dedupedChanges,
      nudge_evaluated: nudgeEvaluated,
      nudge_sent: nudgeSent,
      nudge_text: nudgeText,
      error: null,
    });
    log.info(
      `daily_memory ${dateKey} 完成: episodes=${episodes.length}, storylines=${dedupedChanges.length}, nudge=${nudgeSent ? "sent" : "none"}`,
    );
  } catch (err) {
    memoryService.updateDailyMemoryRun(run.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function runDreamAgent(
  harnessManager: HarnessManager,
  memoryService: MemoryService,
  runId: string,
  dateKey: string,
  consumedBeforeIso: string,
  episodes: Array<Record<string, any>>,
): Promise<string> {
  const scopeId = `daily_memory_dream_${dateKey}`;
  const entry = await harnessManager.getOrCreate(scopeId, "daily_memory", { runId });
  let captured = "";
  const unsubscribe = entry.harness.subscribe(async (event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      captured += event.assistantMessageEvent.delta;
    }
  });

  try {
    // 不变量：dream_agent 永远不能激活 send_checkin；nudge_agent 永远不能激活写记忆工具。
    await entry.harness.setActiveTools(DREAM_TOOL_NAMES);
    await entry.harness.prompt(`# daily_memory / dream_agent

你是内部叙事整理 agent，只维护 storylines。

边界：
- 禁止修改 profile。
- 禁止写 episode。
- 禁止发消息。
- active storyline 是稀缺位，上限是 ${MAX_ACTIVE_STORYLINES}；新建前必须优先尝试延续、合并或唤醒 dormant 线。
- advance_storyline 的 schema 不允许修改 title/kind；不要通过新建来重命名旧线。
- 每次写入必须带 source_episode_ids 和 reason。

处理日期：${dateKey}

本次待消化 episodes（所有 occurred_at 早于 ${consumedBeforeIso} 且尚未被 dream 消化的记录）：
\`\`\`json
${JSON.stringify(formatEpisodesForPrompt(episodes), null, 2)}
\`\`\`

当前 active storylines：
\`\`\`json
${JSON.stringify(memoryService.getActiveStorylines(), null, 2)}
\`\`\`

最近 dormant storylines：
\`\`\`json
${JSON.stringify(memoryService.getRecentDormantStorylines(), null, 2)}
\`\`\`

最近 daily_memory runs：
\`\`\`json
${JSON.stringify(memoryService.getRecentDailyMemoryRuns(5), null, 2)}
\`\`\`

当前 profile（只读）：
${memoryService.getProfile()}

请调用必要工具完成叙事线更新。工具调用结束后，用三五句客观话概括今天 dream 处理了什么。`);
    return captured.trim();
  } finally {
    unsubscribe();
    await harnessManager.resetSession(scopeId);
  }
}

async function runNudgeAgent(
  harnessManager: HarnessManager,
  memoryService: MemoryService,
  runId: string,
  dateKey: string,
  context: NudgeContext,
): Promise<{ sent: boolean; text: string | null }> {
  const scopeId = `daily_memory_nudge_${dateKey}`;
  const entry = await harnessManager.getOrCreate(scopeId, "daily_memory", { runId });
  let sent = false;
  let text: string | null = null;
  const unsubscribe = entry.harness.subscribe(async (event) => {
    if (event.type !== "tool_execution_end" || event.toolName !== "send_checkin" || event.isError) {
      return;
    }
    const details = (event.result as { details?: unknown } | undefined)?.details;
    if (!details || typeof details !== "object") return;
    const record = details as Record<string, unknown>;
    sent = record.sent === true;
    text = typeof record.text === "string" ? record.text : null;
  });

  try {
    await entry.harness.setActiveTools(NUDGE_TOOL_NAMES);
    await entry.harness.prompt(`# daily_memory / nudge_agent

你是内部轻触达判断 agent。默认不发，不发也是正确结果。

硬规则：
- 只能调用 send_checkin 或不调用任何工具。
- 不写 profile、storyline 或 episode。
- 不引用具体负面记忆主动提醒。
- 不把“没记录”说成打卡催促。
- 如果要发，只发一条短文本，像自然关心，不要展开连续对话。

代码层已经确认：
- 连续沉默天数达到 ${NUDGE_AFTER_SILENT_DAYS} 天。
- 距上次实际 send_checkin 至少 ${MIN_NUDGE_INTERVAL_DAYS} 天。

上下文：
\`\`\`json
${JSON.stringify({
  ...context,
  profile: memoryService.getProfile(),
  activeStorylines: memoryService.getActiveStorylines(),
  recentDormantStorylines: memoryService.getRecentDormantStorylines(),
  recentDailyRuns: memoryService.getRecentDailyMemoryRuns(5),
}, null, 2)}
\`\`\`

判断今天是否真的需要轻触达。`);
    return { sent, text };
  } finally {
    unsubscribe();
    await harnessManager.resetSession(scopeId);
  }
}

interface NudgeContext {
  silentDays: number | null;
  lastUserMessageAt: string | null;
  lastNudgeAt: string | null;
  recentNudges: Array<{ date_key: string; nudge_text: string | null; nudge_sent_at: string | null }>;
  recentEpisodeBriefs: Array<{ occurred_at: string; brief: string | null }>;
}

function buildNudgeContext(
  db: Database.Database,
  memoryService: MemoryService,
  clock: Clock,
): NudgeContext {
  const lastUserMessageAt = getLastUserMessageAt(db);
  const silentDays = lastUserMessageAt
    ? Math.floor((clock.now().getTime() - new Date(lastUserMessageAt).getTime()) / 86_400_000)
    : null;
  const lastNudge = memoryService.getLastNudgeSentRun();
  return {
    silentDays,
    lastUserMessageAt,
    lastNudgeAt: lastNudge?.nudge_sent_at ?? null,
    recentNudges: getRecentNudges(db),
    recentEpisodeBriefs: getRecentEpisodeBriefs(db),
  };
}

function shouldRunNudgeAgent(
  memoryService: MemoryService,
  silentDays: number | null,
  clock: Clock,
): boolean {
  if (silentDays === null || silentDays < NUDGE_AFTER_SILENT_DAYS) return false;
  const lastNudge = memoryService.getLastNudgeSentRun();
  if (!lastNudge) return true;
  const daysSinceNudge = Math.floor(
    (clock.now().getTime() - new Date(lastNudge.nudge_sent_at ?? lastNudge.updated_at).getTime()) / 86_400_000,
  );
  return daysSinceNudge >= MIN_NUDGE_INTERVAL_DAYS;
}

function getUndigestedEpisodesForRun(
  db: Database.Database,
  endIso: string,
): Array<Record<string, any>> {
  return db
    .prepare(
      `SELECT id, source_conversation_id, source_message_id, brief, analysis_json, occurred_at
       FROM episodes
       WHERE digested_run_id IS NULL AND occurred_at < ?
       ORDER BY occurred_at ASC`,
    )
    .all(endIso) as Array<Record<string, any>>;
}

function markEpisodesDigested(
  db: Database.Database,
  episodeIds: string[],
  runId: string,
): void {
  if (episodeIds.length === 0) return;
  const placeholders = episodeIds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE episodes
     SET digested_run_id = ?
     WHERE digested_run_id IS NULL AND id IN (${placeholders})`,
  ).run(runId, ...episodeIds);
}

function formatEpisodesForPrompt(episodes: Array<Record<string, any>>): Array<Record<string, any>> {
  return episodes.map((episode) => ({
    id: episode.id,
    occurred_at: episode.occurred_at,
    brief: episode.brief,
    analysis: JSON.parse(String(episode.analysis_json ?? "{}")),
    source_conversation_id: episode.source_conversation_id,
    source_message_id: episode.source_message_id,
  }));
}

function getLastUserMessageAt(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT occurred_at FROM messages
       WHERE role = 'user' AND source != 'import'
       ORDER BY occurred_at DESC
       LIMIT 1`,
    )
    .get() as { occurred_at: string } | undefined;
  return row?.occurred_at ?? null;
}

function getRecentNudges(
  db: Database.Database,
): Array<{ date_key: string; nudge_text: string | null; nudge_sent_at: string | null }> {
  return db
    .prepare(
      `SELECT date_key, nudge_text, nudge_sent_at
       FROM daily_memory_runs
       WHERE nudge_sent = 1
       ORDER BY nudge_sent_at DESC
       LIMIT 3`,
    )
    .all() as Array<{ date_key: string; nudge_text: string | null; nudge_sent_at: string | null }>;
}

function getRecentEpisodeBriefs(
  db: Database.Database,
): Array<{ occurred_at: string; brief: string | null }> {
  return db
    .prepare(
      `SELECT occurred_at, brief
       FROM episodes
       ORDER BY occurred_at DESC
       LIMIT 5`,
    )
    .all() as Array<{ occurred_at: string; brief: string | null }>;
}

function revisionToChange(revision: StorylineRevision): StorylineChangeSummary {
  const next = JSON.parse(revision.new_json) as { title?: string; status?: string };
  return {
    id: revision.storyline_id,
    title: next.title ?? revision.storyline_id,
    operation: revision.operation,
    status: next.status ?? "",
    reason: revision.reason,
    created_at: revision.created_at,
  };
}

function dedupeChanges(changes: StorylineChangeSummary[]): StorylineChangeSummary[] {
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
