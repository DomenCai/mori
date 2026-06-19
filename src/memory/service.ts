import type Database from "better-sqlite3";
import { genId, nowISO } from "../utils.js";
import type {
  CreateWorkingItemData,
  MergeWorkingItemsData,
  UpdateProfileData,
  UpdateWorkingItemData,
} from "../agent/schemas.js";

export const EMPTY_PROFILE = "（尚未建立身份画像）";

export class MemoryService {
  constructor(private db: Database.Database) {}

  // ── Profile ──

  getProfile(): string {
    const row = this.db
      .prepare("SELECT content FROM profile WHERE id = 1")
      .get() as { content: string };
    return row.content;
  }

  updateProfile(data: UpdateProfileData, runId?: string): void {
    const stored = this.getProfile();
    // 占位符不该和正文共存：先剥掉它，old 为真正的画像正文（"" 表示尚无画像）。
    // 这样即便历史脏数据把占位符 baked 进了正文，下一次编辑也会自动清掉。
    const old = stored.replace(EMPTY_PROFILE, "").trim();
    let newContent: string;

    switch (data.operation) {
      case "add":
        newContent = old ? old + "\n" + (data.new_text ?? "") : (data.new_text ?? "");
        break;
      case "replace": {
        if (!data.old_text) throw new Error("replace 需要 old_text");
        if (!old.includes(data.old_text))
          throw new Error(`画像中未找到子串: "${data.old_text}"`);
        newContent = old.replace(data.old_text, data.new_text ?? "");
        break;
      }
      case "remove": {
        if (!data.old_text) throw new Error("remove 需要 old_text");
        if (!old.includes(data.old_text))
          throw new Error(`画像中未找到子串: "${data.old_text}"`);
        newContent = old.replace(data.old_text, "").trim();
        break;
      }
    }

    const finalContent = newContent!.trim() || EMPTY_PROFILE; // 删空了回到占位符
    const now = nowISO();
    this.db.prepare("UPDATE profile SET content = ?, updated_at = ? WHERE id = 1").run(finalContent, now);

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

  // 周合并里静默 finalize 的工作集变更没有审批卡，靠 updated_at 落在本轮窗口内捞出来，回灌进周总结卡片。
  getWorkingItemsTouchedSince(
    sinceIso: string,
  ): Array<{ name: string; type: string; status: string; isNew: boolean }> {
    const rows = this.db
      .prepare(
        "SELECT name, type, status, created_at, updated_at FROM working_items WHERE updated_at >= ? ORDER BY updated_at ASC",
      )
      .all(sinceIso) as Array<{
      name: string;
      type: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      status: r.status,
      isNew: r.created_at >= sinceIso,
    }));
  }

  // ── Working Items ──

  getActiveWorkingItems(): Array<Record<string, any>> {
    return this.db
      .prepare(
        "SELECT * FROM working_items WHERE status = 'active' ORDER BY updated_at DESC",
      )
      .all() as any;
  }

  getAllWorkingItems(): Array<Record<string, any>> {
    return this.db
      .prepare("SELECT * FROM working_items ORDER BY updated_at DESC")
      .all() as any;
  }

  createWorkingItem(data: CreateWorkingItemData, sourceIds: string[] = []): string {
    const now = nowISO();
    const duplicate = this.findDuplicateWorkingItem(data.type, data.name);
    if (duplicate) {
      throw new Error(
        `已存在同名 ${data.type} 工作集：${duplicate.id} ${duplicate.name}，请改用 update_working_item`,
      );
    }

    const id = genId("wi");
    this.db
      .prepare(
        `INSERT INTO working_items (id, type, name, status, thesis, current_questions_json, decisions_json, next_steps_json, related_people_json, source_ids_json, created_at, updated_at, last_mentioned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.type,
        data.name,
        data.status,
        data.thesis ?? null,
        JSON.stringify(data.current_questions ?? []),
        JSON.stringify(data.decisions ?? []),
        JSON.stringify(data.next_steps ?? []),
        JSON.stringify(data.related_people ?? []),
        JSON.stringify(sourceIds),
        now,
        now,
        now,
      );
    return id;
  }

  updateWorkingItem(data: UpdateWorkingItemData, sourceIds: string[] = []): string {
    const existing = this.getWorkingItem(data.id);
    if (!existing) {
      throw new Error(`工作集不存在：${data.id}`);
    }

    this.applyWorkingItemUpdate(data.id, data, sourceIds);
    return data.id;
  }

  mergeWorkingItems(data: MergeWorkingItemsData, sourceIds: string[] = []): string {
    if (data.merge_ids.includes(data.keep_id)) {
      throw new Error("merge_ids 不能包含 keep_id");
    }

    const keep = this.getWorkingItem(data.keep_id);
    if (!keep) throw new Error(`保留工作集不存在：${data.keep_id}`);

    const missing = data.merge_ids.filter((id) => !this.getWorkingItem(id));
    if (missing.length > 0) {
      throw new Error(`待合并工作集不存在：${missing.join(", ")}`);
    }

    const tx = this.db.transaction(() => {
      this.applyWorkingItemUpdate(data.keep_id, data, sourceIds);
      const now = nowISO();
      const mergedStatus = data.merged_item_status ?? "dropped";
      for (const id of data.merge_ids) {
        this.db
          .prepare(
            "UPDATE working_items SET status = ?, updated_at = ?, last_mentioned_at = ? WHERE id = ?",
          )
          .run(mergedStatus, now, now, id);
      }
    });
    tx();
    return data.keep_id;
  }

  getWorkingItem(id: string): Record<string, any> | null {
    return (
      (this.db
        .prepare("SELECT * FROM working_items WHERE id = ?")
        .get(id) as Record<string, any> | undefined) ?? null
    );
  }

  private applyWorkingItemUpdate(
    id: string,
    data: UpdateWorkingItemData | MergeWorkingItemsData,
    sourceIds: string[] = [],
  ): void {
    const now = nowISO();
    const sets: string[] = [];
    const vals: any[] = [];
    sets.push("name = ?"); vals.push(data.name);
    sets.push("type = ?"); vals.push(data.type);
    sets.push("status = ?"); vals.push(data.status);
    sets.push("updated_at = ?"); vals.push(now);
    sets.push("last_mentioned_at = ?"); vals.push(now);

    if (data.thesis !== undefined) { sets.push("thesis = ?"); vals.push(data.thesis); }
    if (data.current_questions) { sets.push("current_questions_json = ?"); vals.push(JSON.stringify(data.current_questions)); }
    if (data.decisions) { sets.push("decisions_json = ?"); vals.push(JSON.stringify(data.decisions)); }
    if (data.next_steps) { sets.push("next_steps_json = ?"); vals.push(JSON.stringify(data.next_steps)); }
    if (data.related_people) { sets.push("related_people_json = ?"); vals.push(JSON.stringify(data.related_people)); }
    if (sourceIds.length) { sets.push("source_ids_json = ?"); vals.push(JSON.stringify(sourceIds)); }

    vals.push(id);
    this.db.prepare(`UPDATE working_items SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  private findDuplicateWorkingItem(
    type: string,
    name: string,
  ): { id: string; name: string } | null {
    const normalized = normalizeWorkingItemName(name);
    const rows = this.db
      .prepare(
        `SELECT id, name FROM working_items
         WHERE type = ? AND status IN ('active', 'dormant')`,
      )
      .all(type) as Array<{ id: string; name: string }>;
    return rows.find((row) => normalizeWorkingItemName(row.name) === normalized) ?? null;
  }
}

function normalizeWorkingItemName(name: string): string {
  return name.trim().toLowerCase();
}
