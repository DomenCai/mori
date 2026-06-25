import { nowISO } from "../utils.js";
import type {
  LarkChatBinding,
  LarkChatType,
  LarkConfig,
} from "../config.js";

export type ChatType = LarkChatType;

export class ChatRegistry {
  // Intentionally mutates this config object in place before persisting it.
  constructor(
    private config: LarkConfig,
    private saveConfig: (cfg: LarkConfig) => void,
  ) {}

  register(chatId: string, chatType: ChatType, name?: string, isDefault?: boolean): void {
    const bindings = this.bindings();
    const existing = bindings.find((item) => item.chatId === chatId);
    if (existing) {
      existing.chatType = chatType;
      existing.name = name;
      if (isDefault !== undefined) existing.isDefault = isDefault;
    } else {
      bindings.push({
        chatId,
        chatType,
        name,
        ...(isDefault ? { isDefault } : {}),
        createdAt: nowISO(),
      });
    }
    this.saveConfig(this.config);
  }

  getType(chatId: string): ChatType | null {
    return this.bindings().find((item) => item.chatId === chatId)?.chatType ?? null;
  }

  getDiaryChats(): string[] {
    return this.bindings()
      .filter((item) => item.chatType === "diary")
      .map((item) => item.chatId);
  }

  findNotificationChatByName(name: string): string | undefined {
    return this.bindings().find(
      (item) => item.chatType === "notification" && item.name === name,
    )?.chatId;
  }

  getDefaultNotificationChat(): string | undefined {
    return this.bindings().find(
      (item) => item.chatType === "notification" && item.isDefault,
    )?.chatId;
  }

  getOwnerOpenId(): string | undefined {
    return this.config.ownerOpenId;
  }

  private bindings(): LarkChatBinding[] {
    this.config.chatBindings ??= [];
    return this.config.chatBindings;
  }
}
