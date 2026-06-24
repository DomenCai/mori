import type Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { genId } from "../utils.js";
import { memoryDir } from "../config.js";
import type {
  AdvanceStorylineData,
  CreateStorylineData,
  MergeStorylinesData,
  SetChapterData,
  SetStorylineStatusData,
  StorylineKind,
  StorylineStatus,
  UpdateProfileData,
} from "../agent/schemas.js";

export const EMPTY_PROFILE = "（尚未建立身份画像）";
export const DORMANT_AFTER_DAYS = 21;
export const MAX_ACTIVE_STORYLINES = 12;

const PROFILE_FILE = "profile.md";
const CHAPTER_FILE = "chapter.md";

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export interface Storyline {
  id: string;
  kind: StorylineKind;
  title: string;
  status: StorylineStatus;
  summary: string;
  current_tension: string | null;
  emotional_arc: string | null;
  people: string[];
  evidence_episode_ids: string[];
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

export interface StorylineRevision {
  id: string;
  storyline_id: string;
  operation: string;
  old_json: string | null;
  new_json: string;
  reason: string;
  source_episode_ids: string[];
  run_id: string | null;
  created_at: string;
}

export interface ProfileRevision {
  id: string;
  old_content: string | null;
  new_content: string;
  source_episode_ids: string[];
  reason: string;
  run_id: string | null;
  created_at: string;
}

export interface StorylineChangeSummary {
  id: string;
  title: string;
  operation: string;
  status: string;
  reason: string;
  created_at: string;
}

export interface ChapterRevision {
  id: string;
  old_content: string | null;
  new_content: string;
  source_storyline_ids: string[];
  source_episode_ids: string[];
  reason: string;
  run_id: string | null;
  created_at: string;
}

export interface DailyMemoryRun {
  id: string;
  date_key: string;
  status: string;
  input_episode_ids: string[];
  dream_summary: string | null;
  storyline_changes: StorylineChangeSummary[];
  nudge_evaluated: boolean;
  nudge_sent: boolean;
  nudge_sent_at: string | null;
  nudge_text: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

type StorylineRow = Omit<Storyline, "people" | "evidence_episode_ids"> & {
  people_json: string;
  evidence_episode_ids_json: string;
};

type RevisionRow = Omit<StorylineRevision, "source_episode_ids"> & {
  source_episode_ids_json: string;
};

type ProfileRevisionRow = Omit<ProfileRevision, "source_episode_ids"> & {
  source_episode_ids_json: string;
};

type ChapterRevisionRow = Omit<
  ChapterRevision,
  "source_storyline_ids" | "source_episode_ids"
> & {
  source_storyline_ids_json: string;
  source_episode_ids_json: string;
};

type DailyRunRow = Omit<
  DailyMemoryRun,
  "input_episode_ids" | "storyline_changes" | "nudge_evaluated" | "nudge_sent"
> & {
  input_episode_ids_json: string;
  storyline_changes_json: string;
  nudge_evaluated: number;
  nudge_sent: number;
};

export class MemoryService {
  constructor(private db: Database.Database, private clock: Clock = systemClock) {
    this.ensureEditableMemoryFiles();
  }

  // ── Profile ──

  getProfile(): string {
    const row = this.db
      .prepare("SELECT content FROM profile WHERE id = 1")
      .get() as { content: string };
    return row.content;
  }

  updateProfile(data: UpdateProfileData, runId?: string): void {
    const stored = this.getProfile();
    const old = stored.replace(EMPTY_PROFILE, "").trim();
    let newContent: string;

    switch (data.operation) {
      case "add":
        newContent = old ? old + "\n" + (data.new_text ?? "") : (data.new_text ?? "");
        break;
      case "replace": {
        if (!data.old_text) throw new Error("replace 需要 old_text");
        if (!old.includes(data.old_text)) {
          throw new Error(`画像中未找到子串: "${data.old_text}"`);
        }
        newContent = old.replace(data.old_text, data.new_text ?? "");
        break;
      }
      case "remove": {
        if (!data.old_text) throw new Error("remove 需要 old_text");
        if (!old.includes(data.old_text)) {
          throw new Error(`画像中未找到子串: "${data.old_text}"`);
        }
        newContent = old.replace(data.old_text, "").trim();
        break;
      }
    }

    const finalContent = newContent!.trim() || EMPTY_PROFILE;
    const now = this.clock.nowISO();
    this.db.prepare("UPDATE profile SET content = ?, updated_at = ? WHERE id = 1").run(finalContent, now);
    this.writeEditableMemoryFile(PROFILE_FILE, finalContent);

    this.db
      .prepare(
        `INSERT INTO profile_revisions (id, old_content, new_content, source_episode_ids_json, reason, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        genId("pr"),
        stored,
        finalContent,
        JSON.stringify(data.source_episode_ids ?? []),
        data.reason,
        runId ?? null,
        now,
      );
  }

  getProfileRevisionsByRun(
    runId: string,
  ): Array<{ old_content: string; new_content: string; reason: string }> {
    return this.db
      .prepare(
        "SELECT old_content, new_content, reason FROM profile_revisions WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(runId) as Array<{
      old_content: string;
      new_content: string;
      reason: string;
    }>;
  }

  getProfileRevisions(limit = 10): ProfileRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM profile_revisions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as ProfileRevisionRow[];
    return rows.map(parseProfileRevision);
  }

  // ── Chapter ──

  getChapter(): string {
    const row = this.db
      .prepare("SELECT content FROM chapter WHERE id = 1")
      .get() as { content: string };
    return row.content;
  }

  setChapter(data: SetChapterData, runId?: string): void {
    const oldContent = this.getChapter();
    const newContent = data.content.trim();
    const now = this.clock.nowISO();
    this.db.prepare("UPDATE chapter SET content = ?, updated_at = ? WHERE id = 1").run(newContent, now);
    this.writeEditableMemoryFile(CHAPTER_FILE, newContent);
    this.db
      .prepare(
        `INSERT INTO chapter_revisions (id, old_content, new_content, source_storyline_ids_json, source_episode_ids_json, reason, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        genId("cr"),
        oldContent,
        newContent,
        JSON.stringify(unique(data.source_storyline_ids)),
        JSON.stringify(unique(data.source_episode_ids ?? [])),
        data.reason,
        runId ?? null,
        now,
      );
  }

  getChapterRevisionsByRun(runId: string): ChapterRevision[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM chapter_revisions WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(runId) as ChapterRevisionRow[];
    return rows.map(parseChapterRevision);
  }

  getChapterRevisions(limit = 10): ChapterRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM chapter_revisions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as ChapterRevisionRow[];
    return rows.map(parseChapterRevision);
  }

  syncEditableMemoryFiles(): void {
    const profile = this.readEditableMemoryFile(PROFILE_FILE, this.getProfile())
      || EMPTY_PROFILE;
    this.syncProfileRow(profile);

    const chapter = this.readEditableMemoryFile(CHAPTER_FILE, this.getChapter());
    this.syncChapterRow(chapter);
  }

  private ensureEditableMemoryFiles(): void {
    this.ensureEditableMemoryFile(PROFILE_FILE, this.getProfile());
    this.ensureEditableMemoryFile(CHAPTER_FILE, this.getChapter());
  }

  private ensureEditableMemoryFile(file: string, content: string): void {
    const path = join(memoryDir, file);
    if (existsSync(path)) return;
    this.writeEditableMemoryFile(file, content);
  }

  private readEditableMemoryFile(file: string, fallback: string): string {
    const path = join(memoryDir, file);
    if (!existsSync(path)) {
      this.writeEditableMemoryFile(file, fallback);
    }
    return stripHtmlComments(readFileSync(path, "utf-8"));
  }

  private writeEditableMemoryFile(file: string, content: string): void {
    mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
    const normalized = content.trim();
    writeFileSync(join(memoryDir, file), normalized ? `${normalized}\n` : "", {
      mode: 0o600,
    });
  }

  private syncProfileRow(content: string): void {
    const oldContent = this.getProfile();
    if (oldContent === content) return;
    const now = this.clock.nowISO();
    this.db.prepare("UPDATE profile SET content = ?, updated_at = ? WHERE id = 1").run(
      content,
      now,
    );
    this.db
      .prepare(
        `INSERT INTO profile_revisions (id, old_content, new_content, source_episode_ids_json, reason, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        genId("pr"),
        oldContent,
        content,
        JSON.stringify([]),
        "manual_file_edit",
        null,
        now,
      );
  }

  private syncChapterRow(content: string): void {
    const oldContent = this.getChapter();
    if (oldContent === content) return;
    const now = this.clock.nowISO();
    this.db.prepare("UPDATE chapter SET content = ?, updated_at = ? WHERE id = 1").run(
      content,
      now,
    );
    this.db
      .prepare(
        `INSERT INTO chapter_revisions (id, old_content, new_content, source_storyline_ids_json, source_episode_ids_json, reason, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        genId("cr"),
        oldContent,
        content,
        JSON.stringify([]),
        JSON.stringify([]),
        "manual_file_edit",
        null,
        now,
      );
  }

  // ── Storylines ──

  getActiveStorylines(): Storyline[] {
    return this.queryStorylines(
      "SELECT * FROM storylines WHERE status = 'active' ORDER BY last_active_at DESC",
    );
  }

  getRecentDormantStorylines(limit = 5): Storyline[] {
    return this.queryStorylines(
      "SELECT * FROM storylines WHERE status = 'dormant' ORDER BY last_active_at DESC LIMIT ?",
      [limit],
    );
  }

  getVisibleStorylines(): Storyline[] {
    return [
      ...this.getActiveStorylines(),
      ...this.getRecentDormantStorylines(),
    ];
  }

  getAllStorylines(): Storyline[] {
    return this.queryStorylines(
      "SELECT * FROM storylines ORDER BY status = 'active' DESC, last_active_at DESC",
    );
  }

  getStoryline(id: string): Storyline | null {
    const row = this.db
      .prepare("SELECT * FROM storylines WHERE id = ?")
      .get(id) as StorylineRow | undefined;
    return row ? parseStoryline(row) : null;
  }

  getStorylineRevisions(id: string): StorylineRevision[] {
    return this.queryRevisions(
      `SELECT * FROM storyline_revisions
       WHERE storyline_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [id],
    );
  }

  getStorylineRevisionsByRun(runId: string): StorylineRevision[] {
    return this.queryRevisions(
      `SELECT * FROM storyline_revisions
       WHERE run_id = ?
       ORDER BY created_at ASC`,
      [runId],
    );
  }

  getStorylineChangesByRuns(runIds: string[]): StorylineChangeSummary[] {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT r.operation, r.reason, r.created_at, s.id, s.title, s.status
         FROM storyline_revisions r
         JOIN storylines s ON s.id = r.storyline_id
         WHERE r.run_id IN (${placeholders})
         ORDER BY r.created_at ASC`,
      )
      .all(...runIds) as Array<StorylineChangeSummary>;
    return rows;
  }

  getStorylineChangesInWindow(sinceIso: string, untilIso: string): StorylineChangeSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.operation, r.reason, r.created_at, s.id, s.title, s.status
         FROM storyline_revisions r
         JOIN storylines s ON s.id = r.storyline_id
         WHERE r.created_at >= ? AND r.created_at < ?
         ORDER BY r.created_at ASC`,
      )
      .all(sinceIso, untilIso) as Array<StorylineChangeSummary>;
    return rows;
  }

  createStoryline(data: CreateStorylineData, runId?: string): string {
    const duplicate = this.findDuplicateStoryline(data.kind, data.title);
    if (duplicate) {
      throw new Error(
        `已存在相近 ${data.kind} storyline：${duplicate.id} ${duplicate.title}，请改用 advance_storyline`,
      );
    }

    const now = this.clock.nowISO();
    const id = genId("sl");
    const storyline: Storyline = {
      id,
      kind: data.kind,
      title: data.title,
      status: "active",
      summary: data.summary,
      current_tension: data.current_tension ?? null,
      emotional_arc: data.emotional_arc ?? null,
      people: data.people ?? [],
      evidence_episode_ids: unique(data.source_episode_ids),
      created_at: now,
      updated_at: now,
      last_active_at: now,
    };

    this.insertStoryline(storyline);
    this.insertRevision({
      storylineId: id,
      operation: "create",
      oldJson: null,
      newStoryline: storyline,
      reason: data.reason,
      sourceEpisodeIds: data.source_episode_ids,
      runId,
      now,
    });
    return id;
  }

  advanceStoryline(data: AdvanceStorylineData, runId?: string): string {
    const existing = this.requireStoryline(data.id);
    const now = this.clock.nowISO();
    const next: Storyline = {
      ...existing,
      status: "active",
      summary: data.summary ?? existing.summary,
      current_tension: data.current_tension ?? existing.current_tension,
      emotional_arc: data.emotional_arc ?? existing.emotional_arc,
      people: data.people ?? existing.people,
      evidence_episode_ids: unique([
        ...existing.evidence_episode_ids,
        ...data.source_episode_ids,
      ]),
      updated_at: now,
      last_active_at: now,
    };
    this.updateStoryline(next);
    this.insertRevision({
      storylineId: data.id,
      operation: "advance",
      oldJson: existing,
      newStoryline: next,
      reason: data.reason,
      sourceEpisodeIds: data.source_episode_ids,
      runId,
      now,
    });
    return data.id;
  }

  setStorylineStatus(data: SetStorylineStatusData, runId?: string): string {
    const existing = this.requireStoryline(data.id);
    const now = this.clock.nowISO();
    const next: Storyline = {
      ...existing,
      status: data.status,
      updated_at: now,
      last_active_at: data.status === "active" ? now : existing.last_active_at,
    };
    this.updateStoryline(next);
    this.insertRevision({
      storylineId: data.id,
      operation: "set_status",
      oldJson: existing,
      newStoryline: next,
      reason: data.reason,
      sourceEpisodeIds: data.source_episode_ids ?? [],
      runId,
      now,
    });
    return data.id;
  }

  mergeStorylines(data: MergeStorylinesData, runId?: string): string {
    if (data.merge_ids.includes(data.keep_id)) {
      throw new Error("merge_ids 不能包含 keep_id");
    }

    const now = this.clock.nowISO();
    const tx = this.db.transaction(() => {
      const keep = this.requireStoryline(data.keep_id);
      const merged = data.merge_ids.map((id) => this.requireStoryline(id));
      const nextKeep: Storyline = {
        ...keep,
        status: "active",
        summary: data.summary,
        current_tension: data.current_tension ?? keep.current_tension,
        emotional_arc: data.emotional_arc ?? keep.emotional_arc,
        people: data.people ?? unique([
          ...keep.people,
          ...merged.flatMap((item) => item.people),
        ]),
        evidence_episode_ids: unique([
          ...keep.evidence_episode_ids,
          ...merged.flatMap((item) => item.evidence_episode_ids),
          ...data.source_episode_ids,
        ]),
        updated_at: now,
        last_active_at: now,
      };
      this.updateStoryline(nextKeep);
      this.insertRevision({
        storylineId: data.keep_id,
        operation: "merge",
        oldJson: keep,
        newStoryline: nextKeep,
        reason: data.reason,
        sourceEpisodeIds: data.source_episode_ids,
        runId,
        now,
      });

      for (const item of merged) {
        const nextMerged: Storyline = {
          ...item,
          status: "closed",
          updated_at: now,
        };
        this.updateStoryline(nextMerged);
        this.insertRevision({
          storylineId: item.id,
          operation: "merged_into",
          oldJson: item,
          newStoryline: nextMerged,
          reason: `${data.reason}; merged_into=${data.keep_id}`,
          sourceEpisodeIds: data.source_episode_ids,
          runId,
          now,
        });
      }
    });
    tx();
    return data.keep_id;
  }

  decayStorylines(opts: {
    runId?: string;
    activeEpisodeIds?: string[];
    now?: Date;
  } = {}): StorylineChangeSummary[] {
    const nowDate = opts.now ?? this.clock.now();
    const now = nowDate.toISOString();
    const threshold = new Date(
      nowDate.getTime() - DORMANT_AFTER_DAYS * 86_400_000,
    ).toISOString();
    const activeEpisodeIds = new Set(opts.activeEpisodeIds ?? []);
    const changes: StorylineChangeSummary[] = [];

    const tx = this.db.transaction(() => {
      const expired = this.queryStorylines(
        `SELECT * FROM storylines
         WHERE status = 'active' AND last_active_at < ?
         ORDER BY last_active_at ASC`,
        [threshold],
      );
      for (const item of expired) {
        changes.push(this.markDormantByDecay(item, "mechanical_decay", opts.runId, now));
      }

      let active = this.getActiveStorylines().sort((a, b) =>
        a.last_active_at.localeCompare(b.last_active_at),
      );
      while (active.length > MAX_ACTIVE_STORYLINES) {
        const candidate = active.find(
          (item) => !item.evidence_episode_ids.some((id) => activeEpisodeIds.has(id)),
        );
        if (!candidate) break;
        changes.push(this.markDormantByDecay(candidate, "mechanical_decay", opts.runId, now));
        active = this.getActiveStorylines().sort((a, b) =>
          a.last_active_at.localeCompare(b.last_active_at),
        );
      }
    });
    tx();
    return changes;
  }

  // ── Daily Memory Runs ──

  getDailyMemoryRun(dateKey: string): DailyMemoryRun | null {
    const row = this.db
      .prepare("SELECT * FROM daily_memory_runs WHERE date_key = ?")
      .get(dateKey) as DailyRunRow | undefined;
    return row ? parseDailyRun(row) : null;
  }

  getRecentDailyMemoryRuns(limit = 7): DailyMemoryRun[] {
    const rows = this.db
      .prepare("SELECT * FROM daily_memory_runs ORDER BY date_key DESC LIMIT ?")
      .all(limit) as DailyRunRow[];
    return rows.map(parseDailyRun);
  }

  getDailyMemoryRunsInDateRange(startDateKey: string, endDateKey: string): DailyMemoryRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM daily_memory_runs
         WHERE date_key >= ? AND date_key < ?
         ORDER BY date_key ASC`,
      )
      .all(startDateKey, endDateKey) as DailyRunRow[];
    return rows.map(parseDailyRun);
  }

  getLatestCompletedDailyMemoryRun(): DailyMemoryRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM daily_memory_runs
         WHERE status = 'completed'
         ORDER BY date_key DESC
         LIMIT 1`,
      )
      .get() as DailyRunRow | undefined;
    return row ? parseDailyRun(row) : null;
  }

  getLastNudgeSentRun(): DailyMemoryRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM daily_memory_runs
         WHERE nudge_sent = 1
         ORDER BY nudge_sent_at DESC
         LIMIT 1`,
      )
      .get() as DailyRunRow | undefined;
    return row ? parseDailyRun(row) : null;
  }

  createDailyMemoryRun(dateKey: string, inputEpisodeIds: string[]): DailyMemoryRun {
    const now = this.clock.nowISO();
    const id = genId("dmr");
    this.db
      .prepare(
        `INSERT INTO daily_memory_runs (id, date_key, status, input_episode_ids_json, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, dateKey, JSON.stringify(inputEpisodeIds), now, now);
    return this.getDailyMemoryRun(dateKey)!;
  }

  updateDailyMemoryRun(
    id: string,
    patch: Partial<{
      status: string;
      dream_summary: string | null;
      storyline_changes: StorylineChangeSummary[];
      nudge_evaluated: boolean;
      nudge_sent: boolean;
      nudge_sent_at: string | null;
      nudge_text: string | null;
      error: string | null;
    }>,
  ): void {
    const updatedAt = this.clock.nowISO();
    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [updatedAt];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.dream_summary !== undefined) {
      sets.push("dream_summary = ?");
      vals.push(patch.dream_summary);
    }
    if (patch.storyline_changes !== undefined) {
      sets.push("storyline_changes_json = ?");
      vals.push(JSON.stringify(patch.storyline_changes));
    }
    if (patch.nudge_evaluated !== undefined) {
      sets.push("nudge_evaluated = ?");
      vals.push(patch.nudge_evaluated ? 1 : 0);
    }
    if (patch.nudge_sent !== undefined) {
      sets.push("nudge_sent = ?");
      vals.push(patch.nudge_sent ? 1 : 0);
      if (patch.nudge_sent) {
        sets.push("nudge_sent_at = coalesce(nudge_sent_at, ?)");
        vals.push(patch.nudge_sent_at ?? updatedAt);
      }
    }
    if (patch.nudge_sent_at !== undefined && !patch.nudge_sent) {
      sets.push("nudge_sent_at = ?");
      vals.push(patch.nudge_sent_at);
    }
    if (patch.nudge_text !== undefined) {
      sets.push("nudge_text = ?");
      vals.push(patch.nudge_text);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      vals.push(patch.error);
    }
    vals.push(id);
    this.db.prepare(`UPDATE daily_memory_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  private queryStorylines(sql: string, params: unknown[] = []): Storyline[] {
    return (this.db.prepare(sql).all(...params) as StorylineRow[]).map(parseStoryline);
  }

  private queryRevisions(sql: string, params: unknown[] = []): StorylineRevision[] {
    return (this.db.prepare(sql).all(...params) as RevisionRow[]).map(parseRevision);
  }

  private requireStoryline(id: string): Storyline {
    const item = this.getStoryline(id);
    if (!item) throw new Error(`storyline 不存在：${id}`);
    return item;
  }

  private insertStoryline(item: Storyline): void {
    this.db
      .prepare(
        `INSERT INTO storylines (id, kind, title, status, summary, current_tension, emotional_arc, people_json, evidence_episode_ids_json, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.kind,
        item.title,
        item.status,
        item.summary,
        item.current_tension,
        item.emotional_arc,
        JSON.stringify(item.people),
        JSON.stringify(item.evidence_episode_ids),
        item.created_at,
        item.updated_at,
        item.last_active_at,
      );
  }

  private updateStoryline(item: Storyline): void {
    this.db
      .prepare(
        `UPDATE storylines
         SET status = ?, summary = ?, current_tension = ?, emotional_arc = ?,
             people_json = ?, evidence_episode_ids_json = ?,
             updated_at = ?, last_active_at = ?
         WHERE id = ?`,
      )
      .run(
        item.status,
        item.summary,
        item.current_tension,
        item.emotional_arc,
        JSON.stringify(item.people),
        JSON.stringify(item.evidence_episode_ids),
        item.updated_at,
        item.last_active_at,
        item.id,
      );
  }

  private insertRevision(opts: {
    storylineId: string;
    operation: string;
    oldJson: Storyline | null;
    newStoryline: Storyline;
    reason: string;
    sourceEpisodeIds: string[];
    runId?: string;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO storyline_revisions (id, storyline_id, operation, old_json, new_json, reason, source_episode_ids_json, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        genId("sr"),
        opts.storylineId,
        opts.operation,
        opts.oldJson ? JSON.stringify(opts.oldJson) : null,
        JSON.stringify(opts.newStoryline),
        opts.reason,
        JSON.stringify(unique(opts.sourceEpisodeIds)),
        opts.runId ?? null,
        opts.now,
      );
  }

  private markDormantByDecay(
    item: Storyline,
    reason: string,
    runId: string | undefined,
    now: string,
  ): StorylineChangeSummary {
    const next: Storyline = {
      ...item,
      status: "dormant",
      updated_at: now,
    };
    this.updateStoryline(next);
    this.insertRevision({
      storylineId: item.id,
      operation: "decay",
      oldJson: item,
      newStoryline: next,
      reason,
      sourceEpisodeIds: [],
      runId,
      now,
    });
    return {
      id: item.id,
      title: item.title,
      operation: "decay",
      status: "dormant",
      reason,
      created_at: now,
    };
  }

  private findDuplicateStoryline(
    kind: StorylineKind,
    title: string,
  ): { id: string; title: string } | null {
    const normalized = normalizeTitle(title);
    const rows = this.db
      .prepare(
        `SELECT id, title FROM storylines
         WHERE kind = ? AND status IN ('active', 'dormant')`,
      )
      .all(kind) as Array<{ id: string; title: string }>;
    return rows.find((row) => normalizeTitle(row.title) === normalized) ?? null;
  }
}

function parseStoryline(row: StorylineRow): Storyline {
  const { people_json, evidence_episode_ids_json, ...rest } = row;
  return {
    ...rest,
    kind: row.kind as StorylineKind,
    status: row.status as StorylineStatus,
    people: parseJsonArray(people_json),
    evidence_episode_ids: parseJsonArray(evidence_episode_ids_json),
  };
}

function parseRevision(row: RevisionRow): StorylineRevision {
  const { source_episode_ids_json, ...rest } = row;
  return {
    ...rest,
    source_episode_ids: parseJsonArray(source_episode_ids_json),
  };
}

function parseProfileRevision(row: ProfileRevisionRow): ProfileRevision {
  const { source_episode_ids_json, ...rest } = row;
  return {
    ...rest,
    source_episode_ids: parseJsonArray(source_episode_ids_json),
  };
}

function parseChapterRevision(row: ChapterRevisionRow): ChapterRevision {
  const {
    source_storyline_ids_json,
    source_episode_ids_json,
    ...rest
  } = row;
  return {
    ...rest,
    source_storyline_ids: parseJsonArray(source_storyline_ids_json),
    source_episode_ids: parseJsonArray(source_episode_ids_json),
  };
}

function parseDailyRun(row: DailyRunRow): DailyMemoryRun {
  const {
    input_episode_ids_json,
    storyline_changes_json,
    nudge_evaluated,
    nudge_sent,
    ...rest
  } = row;
  return {
    ...rest,
    input_episode_ids: parseJsonArray(input_episode_ids_json),
    storyline_changes: parseJsonArray(storyline_changes_json),
    nudge_evaluated: nudge_evaluated === 1,
    nudge_sent: nudge_sent === 1,
  };
}

function parseJsonArray(value: string): any[] {
  const parsed = JSON.parse(value || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items.filter((item) => item !== null && item !== undefined)));
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase();
}
