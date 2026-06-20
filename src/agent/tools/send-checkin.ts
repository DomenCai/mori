import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LarkChannel } from "@larksuite/channel";
import { SendCheckinParams } from "../schemas.js";
import type { ChatRegistry } from "../../lark/chatRegistry.js";
import type { MessageService } from "../../storage/messages.js";
import { larkChatConversationId, larkMessageId } from "../../lark/ingest.js";

export function createSendCheckinTool(
  channel: LarkChannel,
  registry: ChatRegistry,
  messageService: MessageService,
): AgentTool<typeof SendCheckinParams> {
  return {
    name: "send_checkin",
    label: "发送轻触达",
    description:
      "向日记群发送一条短的关心文本。只能由 nudge_agent 调用；不写任何长期记忆。",
    parameters: SendCheckinParams,
    execute: async (_id, params) => {
      const diaryChats = registry.getDiaryChats();
      for (const chatId of diaryChats) {
        const sent = await channel.send(chatId, { text: params.text });
        messageService.saveAssistantMessage({
          id: larkMessageId(sent.messageId)!,
          source: "lark",
          conversationId: larkChatConversationId(chatId),
          conversationType: "diary",
          content: params.text,
        });
      }
      return {
        content: [{ type: "text", text: `check-in 已发送到 ${diaryChats.length} 个日记群` }],
        details: { sent: diaryChats.length > 0, text: params.text, chatCount: diaryChats.length },
      };
    },
  };
}
