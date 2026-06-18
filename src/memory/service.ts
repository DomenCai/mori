import type Database from "better-sqlite3";
import { genId, nowISO } from "../utils.js";
import type {
  UpsertWorkingItemData,
  UpdateProfileData,
} from "../agent/schemas.js";

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
    const old = this.getProfile();
    let newContent: string;

    switch (data.operation) {
      case "add":
        newContent = old + "\n" + (data.new_text ?? "");
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

    const now = nowISO();
    this.db.prepare("UPDATE profile SET content = ?, updated_at = ? WHERE id = 1").run(newContent!, now);

    this.db
      .prepare(
        `INSERT INTO profile_revisions (id, old_content, new_content, source_episode_ids_json, source_diary_ids_json, reason, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        genId("pr"),
        old,
        newContent!,
        JSON.stringify(data.source_episode_ids ?? []),
        JSON.stringify(data.source_diary_ids ?? []),
        data.reason,
        runId ?? null,
        now,
      );
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

  upsertWorkingItem(data: UpsertWorkingItemData, sourceIds: string[] = []): string {
    const now = nowISO();

    if (data.id) {
      const existing = this.db
        .prepare("SELECT id FROM working_items WHERE id = ?")
        .get(data.id);
      if (existing) {
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

        vals.push(data.id);
        this.db.prepare(`UPDATE working_items SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        return data.id;
      }
    }

    const id = data.id ?? genId("wi");
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
}
