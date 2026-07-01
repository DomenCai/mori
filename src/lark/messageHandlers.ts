// 飞书消息 → agent 驱动。这里负责业务分流，具体回复形态在 replies.ts。
import type {
  LarkChannel,
  NormalizedMessage,
} from "@larksuite/channel";
import { AgentService } from "../agent/index.js";
import { distillDiaryEntry } from "../diary/distill.js";
import type { IngestedMessage } from "../ingest/message.js";
import { larkMessageId, larkThreadKey } from "./ingest.js";
import { formatLensPrompt, type ParsedLens } from "./lenses.js";
import { isWebSearchConfigured } from "../agent/tools/web-search.js";
import { renderClipCard } from "./cards.js";
import {
  type AgentReplyResult,
  replyModeForChat,
  sendAgentReply,
  sendCardReply,
  sendTextReply,
} from "./replies.js";
import { logger } from "../log.js";
import { nowISO } from "../utils.js";
import { fetchArticle } from "../knowledge/fetch.js";

const larkLog = logger("lark");
const diaryLog = logger("diary");

export function isRootMessage(msg: NormalizedMessage): boolean {
  return !msg.replyToMessageId && (!msg.rootId || msg.rootId === msg.messageId);
}

export function isThreadReplyMessage(msg: NormalizedMessage): boolean {
  return !!larkThreadKey(msg) && !isRootMessage(msg);
}

export async function handleDiaryMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
  mode: "entry" | "reply",
): Promise<void> {
  const scopeId = message.conversationId;
  await agentService.withScopeLock(scopeId, () =>
    handleDiaryMessageInLock(msg, message, channel, agentService, mode),
  );
}

async function handleDiaryMessageInLock(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
  mode: "entry" | "reply",
): Promise<void> {
  const scopeId = message.conversationId;
  const agent = await agentService.getOrCreateForMessageInLock(scopeId, "diary", message);
  const messageService = agentService.getMessageService();
  const messageTime = message.occurredAt;
  if (mode === "reply") {
    messageService.saveUserMessage(message);
    agentService.recordUserMessage(scopeId, message.id, message.occurredAt);
  } else {
    // entry 模式下 distillDiaryEntry 内部会 saveUserMessage，但 message_session_entries
    // 仍要由 handler 这层来登记，确保未来回复这条日记 anchor 时能命中 session。
    agentService.recordUserMessage(scopeId, message.id, message.occurredAt);
  }
  agentService.recordActivity(scopeId, messageTime);

  // 日记 scope 工具集恒定 [write_episode, search_memory]，不切工具（切了会炸缓存）。
  // 追问轮硬拦 write_episode；新日记轮放行（蒸馏需要它）。
  if (mode === "reply") {
    agent.blockTools(["write_episode"], "日记追问轮不写 episode");
  } else {
    agent.resetTools();
  }

  diaryLog.info(
    mode === "entry"
      ? `处理日记 conversation=${message.conversationId} messageId=${message.id}`
      : `处理日记回复 chat=${msg.chatId} replyTo=${msg.replyToMessageId ?? "unknown"}`,
  );

  const runPrompt = async () => {
    if (mode === "entry") {
      const episodeResult = await distillDiaryEntry({
        agentService,
        message,
      });
      return {
        promptError: episodeResult.promptError ?? null,
        successStatus: episodeResult.fallbackReason
          ? `> ${episodeResult.fallbackReason}`
          : undefined,
        errorStatus: episodeResult.fallbackReason
          ? `> ${episodeResult.fallbackReason}`
          : episodeResult.promptError
            ? `> 处理失败，已保存原文和兜底 episode：${episodeResult.promptError}`
            : undefined,
      };
    }
    await agent.prompt(
      await formatDiaryPrompt(message, agentService),
    );
    return undefined;
  };

  const sent = await (async () => {
    try {
      return await sendAgentReply(
        "agent-card-stream",
        channel,
        msg,
        agent,
        runPrompt,
        diaryLog,
        { replyInThread: false },
      );
    } finally {
      agent.setEpisodeSource(null);
    }
  })();

  recordAssistantReplyMessages(agentService, scopeId, message, sent);
}

export async function handleChatMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
  chatType: "dm" | "topic" | "thread",
): Promise<void> {
  const scopeId = message.conversationId;
  await agentService.withScopeLock(scopeId, () =>
    handleChatMessageInLock(msg, message, channel, agentService, chatType),
  );
}

async function handleChatMessageInLock(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
  chatType: "dm" | "topic" | "thread",
): Promise<void> {
  const scopeId = message.conversationId;
  const agent = await agentService.getOrCreateForMessageInLock(scopeId, chatType, message);
  const messageService = agentService.getMessageService();
  const messageTime = message.occurredAt;
  messageService.saveUserMessage(message);
  agentService.recordUserMessage(scopeId, message.id, message.occurredAt);
  agentService.recordActivity(scopeId, messageTime);
  larkLog.info(`处理对话 scope=${scopeId} type=${chatType}`);

  const runPrompt = async () => {
    await agent.prompt(
      await formatChatPrompt(message, agentService),
    );
  };
  const sent = await sendAgentReply(
    replyModeForChat(chatType, msg, isThreadReplyMessage(msg)),
    channel,
    msg,
    agent,
    runPrompt,
    larkLog,
  );

  recordAssistantReplyMessages(agentService, scopeId, message, sent);
}

export async function handleLensMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
  chatType: "dm" | "topic" | "thread",
  lens: ParsedLens,
): Promise<void> {
  const target = lens.body || buildLensReplyTarget(message, agentService);
  if (!target) {
    await sendTextReply(channel, msg, "命令后面给内容，或回复某条消息");
    return;
  }

  const scopeId = message.conversationId;
  await agentService.withScopeLock(scopeId, () =>
    handleLensMessageInLock(msg, message, channel, agentService, chatType, lens, target),
  );
}

async function handleLensMessageInLock(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
  chatType: "dm" | "topic" | "thread",
  lens: ParsedLens,
  target: string,
): Promise<void> {
  const scopeId = message.conversationId;
  const agent = await agentService.getOrCreateForMessageInLock(scopeId, chatType, message);
  const messageService = agentService.getMessageService();
  messageService.saveUserMessage(message);
  agentService.recordUserMessage(scopeId, message.id, message.occurredAt);
  agentService.recordActivity(scopeId, message.occurredAt);
  larkLog.info(`处理 lens scope=${scopeId} type=${chatType} lens=${lens.lens}`);

  // 透镜轮只放行 lens 允许的工具，但不切工具集（切了会炸活跃会话的缓存），
  // 改成把其余工具拦在调用层。
  const allowed = new Set(lensToolNames(lens));
  const blocked = agent
    .getActiveTools()
    .map((tool) => tool.name)
    .filter((name) => !allowed.has(name));

  try {
    agent.blockTools(blocked, "思考透镜轮只用该透镜允许的工具");
    const runPrompt = async () => {
      await agent.prompt(formatLensPrompt(lens.lens, target));
    };
    const sent = await sendAgentReply(
      replyModeForChat(chatType, msg, isThreadReplyMessage(msg)),
      channel,
      msg,
      agent,
      runPrompt,
      larkLog,
    );

    recordAssistantReplyMessages(agentService, scopeId, message, sent);
  } finally {
    agent.resetTools();
  }
}

function recordAssistantReplyMessages(
  agentService: AgentService,
  scopeId: string,
  message: IngestedMessage,
  sent: AgentReplyResult,
): void {
  const assistantOccurredAt = nowISO();
  const messageService = agentService.getMessageService();
  for (let i = 0; i < sent.messageIds.length; i++) {
    const id = larkMessageId(sent.messageIds[i])!;
    const text = sent.texts[i] ?? sent.assistantText ?? "（卡片回复）";
    messageService.saveAssistantMessage({
      id,
      source: "lark",
      conversationId: message.conversationId,
      conversationType: message.conversationType,
      content: text || "（卡片回复）",
      replyTo: message.id,
      threadId: message.threadId,
      rootId: message.rootId,
      occurredAt: assistantOccurredAt,
    });
    agentService.recordAssistantMessage(scopeId, id, assistantOccurredAt);
  }
}

function lensToolNames(lens: ParsedLens): string[] {
  if (lens.lens !== "plain") return [];
  return isWebSearchConfigured() ? ["web_search", "fetch_article"] : ["fetch_article"];
}

export async function handleNotificationMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
): Promise<boolean> {
  if (isThreadReplyMessage(msg)) {
    return false;
  }
  const messageService = agentService.getMessageService();
  messageService.saveUserMessage(message);
  if (!msg.replyToMessageId) {
    await channel.send(msg.chatId, { text: notificationReplyHint() });
    return true;
  }

  await sendTextReply(channel, msg, notificationReplyHint());
  return true;
}

function notificationReplyHint(): string {
  return "长按通知内容，创建话题可以继续聊；要收藏这条通知，请回复它发送 /clip。";
}

export async function handleClipMessage(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
): Promise<void> {
  const scopeId = message.conversationId;
  await agentService.withScopeLock(scopeId, () =>
    handleClipMessageInLock(msg, message, channel, agentService),
  );
}

async function handleClipMessageInLock(
  msg: NormalizedMessage,
  message: IngestedMessage,
  channel: LarkChannel,
  agentService: AgentService,
): Promise<void> {
  if (isThreadReplyMessage(msg)) {
    await handleChatMessageInLock(msg, message, channel, agentService, "thread");
    return;
  }
  if (!isRootMessage(msg)) {
    await sendTextReply(channel, msg, "长按收藏反馈卡，创建话题可以继续聊这篇。");
    return;
  }

  try {
    await channel.addReaction(msg.messageId, "OnIt");
  } catch (err) {
    larkLog.warn(`收藏群回执表情失败 message=${msg.messageId}`, err);
  }

  await saveClipContent(msg, message, message.content, channel, agentService);
}

export async function saveClipContent(
  msg: NormalizedMessage,
  message: IngestedMessage,
  content: string,
  channel: LarkChannel,
  agentService: AgentService,
  options: { originNote?: string } = {},
): Promise<void> {
  const url = parsePureUrl(content);
  const article = url
    ? await fetchArticle(url, channel.rawClient)
    : {
        title: truncatePlain(firstLine(content), 40),
        body: content,
        source_url: "",
        fetch_status: "ok" as const,
      };
  const result = agentService.getVaultService().ingestNote({
    title: article.title || url || truncatePlain(firstLine(content), 40),
    body: article.body,
    source_type: "clip",
    source_url: url ?? undefined,
    origin_note: options.originNote ?? content,
  });
  const messageService = agentService.getMessageService();
  messageService.saveUserMessage({
    ...message,
    content,
    knowledgePath: result.path,
  });

  const title = result.status === "duplicate"
    ? "📁 已收藏过"
    : article.fetch_status === "failed"
      ? "⚠️ 抓取失败"
      : "✅ 已收藏";
  const body = clipCardBody({
    title: result.title,
    url,
    body: article.body,
    failed: article.fetch_status === "failed",
  });
  const sent = await sendCardReply(channel, msg, renderClipCard(title, body));
  messageService.saveAssistantMessage({
    id: larkMessageId(sent.messageId)!,
    source: "lark",
    conversationId: message.conversationId,
    conversationType: message.conversationType,
    content: body,
    replyTo: message.id,
    knowledgePath: result.path,
  });
}

async function formatDiaryPrompt(
  message: IngestedMessage,
  agentService: AgentService,
): Promise<string> {
  const replyContext = buildReplyContext(message, agentService);

  return `${replyContext}<diary_followup>
这是同一篇日记里的继续回复，不是新日记：本轮不要调用 write_episode，也不要把它当成新日记入库。保持日记群的陪伴语气和上下文连续性。
</diary_followup>

<my_message>
${message.content}
</my_message>`;
}

async function formatChatPrompt(
  message: IngestedMessage,
  agentService: AgentService,
): Promise<string> {
  return `${buildReplyContext(message, agentService)}<my_message>
${message.content}
</my_message>`;
}

export function buildReplyContext(
  message: IngestedMessage,
  agentService: AgentService,
): string {
  const messageService = agentService.getMessageService();
  const contextMessageIds = [message.replyTo, message.rootId].filter(
    (id, index, ids): id is string => !!id && ids.indexOf(id) === index,
  );
  let plainParent: ReturnType<typeof messageService.get> = null;
  for (const contextMessageId of contextMessageIds) {
    const parent = messageService.get(contextMessageId);
    const knowledgeSource = parent?.knowledge_path
      ? parent
      : messageService.findKnowledgeReplyForMessage(contextMessageId);
    if (knowledgeSource?.knowledge_path) {
      return formatRepliedMessage(
        parent?.content ?? knowledgeSource.content,
        knowledgeSource.knowledge_path,
      );
    }
    plainParent ??= parent;
  }
  return plainParent ? formatRepliedMessage(plainParent.content) : "";
}

function formatRepliedMessage(content: string, knowledgePath?: string | null): string {
  const knowledge = knowledgePath
    ? `这是对知识卡片的回应，对应知识文件：${knowledgePath}\n`
    : "";
  return `<replied_message>
${knowledge}${content}
</replied_message>

`;
}

function buildLensReplyTarget(
  message: IngestedMessage,
  agentService: AgentService,
): string {
  const contextMessageId = message.replyTo ?? message.rootId;
  if (!contextMessageId) return "";
  const parent = agentService.getMessageService().get(contextMessageId);
  return parent?.content.trim() ?? "";
}

function parsePureUrl(text: string): string | null {
  const value = text.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() || "未命名";
}

function truncatePlain(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function clipCardBody(input: {
  title: string;
  url: string | null;
  body: string;
  failed: boolean;
}): string {
  if (input.failed) {
    return `${input.url ?? input.title}\n\n已记下链接，但内容抓不到。`;
  }
  const preview = truncatePlain(input.body, 80);
  return preview ? `《${input.title}》\n\n${preview}` : `《${input.title}》`;
}
