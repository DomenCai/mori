export type MessageSource = "lark" | "import" | "desktop";

export type ConversationType =
  | "diary"
  | "dm"
  | "topic"
  | "thread"
  | "notification"
  | "clip";

export interface IngestedMessage {
  id: string;
  source: MessageSource;
  conversationId: string;
  conversationType: ConversationType;
  role: "user";
  content: string;
  occurredAt: string;
  replyTo?: string | null;
  threadId?: string | null;
  rootId?: string | null;
  knowledgePath?: string | null;
}
