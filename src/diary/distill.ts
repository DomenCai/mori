import type { BaseAgent, AgentService } from "../agent/index.js";
import type { IngestedMessage } from "../ingest/message.js";
import type { DiaryService, EpisodeSource } from "./service.js";

export interface DistillDiaryEntryResult {
  fallbackReason?: string;
  promptError?: string;
}

export async function distillDiaryEntry(opts: {
  agentService: AgentService;
  message: IngestedMessage;
  sessionScope?: string;
}): Promise<DistillDiaryEntryResult> {
  const { agentService, message } = opts;
  const sessionScope = opts.sessionScope ?? message.conversationId;
  const agent = await agentService.getOrCreate(sessionScope, "diary");
  const diaryService = agentService.getDiaryService();
  const messageService = agentService.getMessageService();

  messageService.saveUserMessage(message);
  agentService.recordActivity(sessionScope, message.occurredAt);

  const source: EpisodeSource = {
    conversationId: message.conversationId,
    messageId: message.id,
    startedAt: message.occurredAt,
    endedAt: message.occurredAt,
  };

  agent.setEpisodeSource(source);

  let promptError: string | null = null;
  try {
    await agent.prompt(formatDiaryEntryPrompt(message));
  } catch (err) {
    promptError = formatError(err);
  }

  try {
    if (promptError) {
      if (!diaryService.hasEpisodeForMessage(message.id)) {
        diaryService.saveFallbackEpisode(source, message.content);
      }
      return {
        promptError,
        fallbackReason: `处理失败，已保存原文和兜底 episode：${promptError}`,
      };
    }

    return await ensureDiaryEpisode(diaryService, agent, source, message.content);
  } finally {
    agent.setEpisodeSource(null);
  }
}

async function ensureDiaryEpisode(
  diaryService: DiaryService,
  agent: BaseAgent,
  source: EpisodeSource,
  content: string,
): Promise<DistillDiaryEntryResult> {
  if (source.messageId && diaryService.hasEpisodeForMessage(source.messageId)) {
    return {};
  }

  try {
    await agent.prompt(`你刚才没有为这篇日记写 episode。请只调用 write_episode 工具完成蒸馏，不要输出面向用户的回复文本。

原日记：
${content}`);
  } catch {
    diaryService.saveFallbackEpisode(source, content);
    return { fallbackReason: "episode 补救失败，已保存最小兜底 episode" };
  }

  if (source.messageId && diaryService.hasEpisodeForMessage(source.messageId)) {
    return {};
  }

  diaryService.saveFallbackEpisode(source, content);
  return { fallbackReason: "模型未写 episode，已保存最小兜底 episode" };
}

function formatDiaryEntryPrompt(message: IngestedMessage): string {
  if (message.source === "import") {
    return `[历史日记导入]
这是一篇历史日记。请只调用 write_episode 工具把原文蒸馏成 episode，不要输出面向用户的回复文本。

原文：
${message.content}`;
  }

  return `[日记群新日记]
这是一条新的日记入口消息。请先调用 write_episode 工具，把原文蒸馏成 episode；必要时再调用其它工具；最后按 response_style 选最合适的模式回应，长短随内容走，该深就深，该一句就一句。

原文：
${message.content}`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
