import type Database from "better-sqlite3";
import { nowISO } from "../utils.js";

export type ChatType = "diary" | "topic" | "notification" | "dm";

export class ChatRegistry {
  constructor(private db: Database.Database) {}

  register(chatId: string, chatType: ChatType, name?: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chat_registry (chat_id, chat_type, name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(chatId, chatType, name ?? null, nowISO());
  }

  getType(chatId: string): ChatType | null {
    const row = this.db
      .prepare("SELECT chat_type FROM chat_registry WHERE chat_id = ?")
      .get(chatId) as { chat_type: ChatType } | undefined;
    return row?.chat_type ?? null;
  }

  getDiaryChats(): string[] {
    return (
      this.db
        .prepare(
          "SELECT chat_id FROM chat_registry WHERE chat_type = 'diary'",
        )
        .all() as Array<{ chat_id: string }>
    ).map((r) => r.chat_id);
  }
}
