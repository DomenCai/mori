import {
  AgentHarness,
  JsonlSessionRepo,
  type AgentTool,
  type AgentHarnessStreamOptions,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type { LarkChannel } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { DiaryService, type EpisodeSource } from "../diary/service.js";
import { MemoryService } from "../memory/service.js";
import { MessageService } from "../storage/messages.js";
import { VaultService } from "../knowledge/vault.js";
import { buildMemorySnapshot, buildSystemPrompt } from "./prompts.js";
import { createWriteEpisodeTool } from "./tools/write-episode.js";
import {
  createAdvanceStorylineTool,
  createCreateStorylineTool,
  createGetStorylineTool,
  createMergeStorylinesTool,
  createSetStorylineStatusTool,
} from "./tools/storylines.js";
import { createUpdateProfileTool } from "./tools/update-profile.js";
import { createSearchMemoryTool } from "./tools/search-memory.js";
import { createSendCheckinTool } from "./tools/send-checkin.js";
import { createKnowledgeTools } from "./tools/knowledge.js";
import { isWebSearchConfigured } from "./tools/web-search.js";
import { genId, businessDateKey, businessFileTimestamp } from "../utils.js";
import type { SessionPolicyConfig } from "../config.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";

export interface HarnessEntry {
  harness: AgentHarness;
  scopeId: string;
  chatType:
    | "diary"
    | "dm"
    | "topic"
    | "thread"
    | "consolidation"
    | "knowledge_index"
    | "daily_memory";
  routeName: "companion" | "weekly";
  modelId: string;
  runId?: string;
  lastActivityAt: number;
  activeToolNames: string[];
  segmentStartedAt: string | null;
  segmentEndedAt: string | null;
  currentEpisodeSource: EpisodeSource | null;
}

export interface HarnessModelRoute {
  name: "companion" | "weekly";
  model: Model<any>;
  apiKey: string;
  streamOptions: AgentHarnessStreamOptions;
  thinkingLevel?: ThinkingLevel;
}

export interface HarnessManagerOptions {
  db: Database.Database;
  sessionsDir: string;
  routes: {
    companion: HarnessModelRoute;
    weekly: HarnessModelRoute;
  };
  channel?: LarkChannel;
  registry?: ChatRegistry;
  clock?: Clock;
}

export class HarnessManager {
  private entries = new Map<string, HarnessEntry>();
  private env: NodeExecutionEnv;
  private repo: JsonlSessionRepo;
  private diaryService: DiaryService;
  private memoryService: MemoryService;
  private messageService: MessageService;
  private vaultService: VaultService;
  private db: Database.Database;
  private routes: HarnessManagerOptions["routes"];
  private channel?: LarkChannel;
  private registry?: ChatRegistry;
  private clock: Clock;

  constructor(opts: HarnessManagerOptions) {
    this.db = opts.db;
    this.routes = opts.routes;
    this.clock = opts.clock ?? systemClock;
    this.env = new NodeExecutionEnv({ cwd: process.cwd() });
    this.repo = new JsonlSessionRepo({
      fs: this.env,
      sessionsRoot: opts.sessionsDir,
    });
    this.installSessionFileNames();
    this.diaryService = new DiaryService(opts.db, this.clock);
    this.memoryService = new MemoryService(opts.db, this.clock);
    this.messageService = new MessageService(opts.db, this.clock);
    this.vaultService = new VaultService();
    this.channel = opts.channel;
    this.registry = opts.registry;
  }

  getDiaryService(): DiaryService {
    return this.diaryService;
  }

  getMemoryService(): MemoryService {
    return this.memoryService;
  }

  getMessageService(): MessageService {
    return this.messageService;
  }

  getVaultService(): VaultService {
    return this.vaultService;
  }

  getClock(): Clock {
    return this.clock;
  }

  async getOrCreate(
    scopeId: string,
    chatType: HarnessEntry["chatType"],
    opts: { runId?: string } = {},
  ): Promise<HarnessEntry> {
    const existing = this.entries.get(scopeId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      existing.runId = opts.runId ?? existing.runId;
      return existing;
    }
    return this.createEntry(scopeId, chatType, opts);
  }

  recordActivity(scopeId: string, createdAt: string): void {
    const entry = this.entries.get(scopeId);
    if (!entry) return;
    entry.lastActivityAt = Date.now();
    entry.segmentStartedAt ??= createdAt;
    entry.segmentEndedAt = createdAt;
  }

  setCurrentEpisodeSource(scopeId: string, source: EpisodeSource | null): void {
    const entry = this.entries.get(scopeId);
    if (entry) entry.currentEpisodeSource = source;
  }

  async resetSession(scopeId: string): Promise<void> {
    await this.distillScopeEpisode(scopeId);
    this.entries.delete(scopeId);
  }

  async compactSession(scopeId: string): Promise<void> {
    await this.distillScopeEpisode(scopeId);
    const entry = this.entries.get(scopeId);
    if (entry) await entry.harness.compact();
  }

  async cleanupIdle(policy: SessionPolicyConfig): Promise<void> {
    const now = Date.now();
    for (const [scopeId, entry] of this.entries) {
      const item = policy[policyKeyForChatType(entry.chatType)];
      if (!item.autoClose || !item.idleMinutes) continue;
      if (now - entry.lastActivityAt > item.idleMinutes * 60_000) {
        await this.distillScopeEpisode(scopeId);
        this.entries.delete(scopeId);
      }
    }
  }

  async distillScopeEpisode(scopeId: string): Promise<void> {
    const entry = this.entries.get(scopeId);
    if (!entry || !shouldDistillOnClose(entry.chatType)) return;
    if (!entry.segmentStartedAt || !entry.segmentEndedAt) return;

    const source: EpisodeSource = {
      conversationId: scopeId,
      messageId: null,
      startedAt: entry.segmentStartedAt,
      endedAt: entry.segmentEndedAt,
    };
    if (this.diaryService.hasEpisodeForScopeWindow(source)) return;

    const messages = this.messageService.getConversationMessages(
      scopeId,
      source.startedAt,
      source.endedAt,
    );
    if (!messages.some((message) => message.role === "user")) return;

    const restoreToolNames = [...entry.activeToolNames];
    entry.currentEpisodeSource = source;
    const transcript = messages
      .map((message) => `[${message.occurred_at}] ${message.role}: ${message.content}`)
      .join("\n\n");

    try {
      await entry.harness.setActiveTools(["write_episode"]);
      await entry.harness.prompt(`# 会话片段蒸馏

请只调用 write_episode，把下面这段已经结束的对话蒸馏成一条 episode。
只记录和用户长期上下文有关的事实、判断、行动和偏好信号；不要修改身份画像，不要输出面向用户的回复文本。

${transcript}`);
    } catch {
      // 统一在 finally 里检查是否实际落库，避免工具已成功但 prompt 后续失败时写双份。
    } finally {
      try {
        if (!this.diaryService.hasEpisodeForScopeWindow(source)) {
          this.diaryService.saveFallbackEpisode(source, transcript);
        }
      } finally {
        await entry.harness.setActiveTools(restoreToolNames);
        entry.currentEpisodeSource = null;
        entry.segmentStartedAt = null;
        entry.segmentEndedAt = null;
      }
    }
  }

  async runKnowledgeIndexBuiltin(): Promise<string> {
    const runId = genId("run");
    const scopeId = `knowledge_index_${runId}`;
    const entry = await this.getOrCreate(scopeId, "knowledge_index", { runId });
    const files = this.vaultService
      .listFrontmatter()
      .filter((file) => file.path !== ".index.md")
      .map((file) => ({
        path: file.path,
        frontmatter: file.frontmatter,
      }));

    if (files.length === 0) {
      return this.vaultService.writeKnowledgeIndex("# 知识地图\n\n暂无知识库内容。\n");
    }

    let indexText = "";
    const unsubscribe = entry.harness.subscribe(async (event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        indexText += event.assistantMessageEvent.delta;
      }
    });

    try {
      await entry.harness.setActiveTools(["read_vault"]);
      await entry.harness.prompt(`# 知识地图 builtin

你的目标是维持一张压缩、可导航的知识地图，如实反映知识库已有内容，让未来的我和 Agent 知道我沉淀了什么、该往哪里挖。

请基于下面每个 vault 文件的 path + frontmatter 生成一份 Markdown 知识地图，直接输出最终 .index.md 正文。

要求：
- 顶层按领域聚类，压缩总结而不是罗列目录。
- 总长度控制在 3000 token 内。
- 可以在必要时调用 read_vault 读取少量文件确认细节，但默认不要读全文。
- 不要修改任何 vault 文件正文。

vault frontmatter:
\`\`\`json
${JSON.stringify(files, null, 2)}
\`\`\``);
      const content = indexText.trim();
      if (!content) throw new Error("knowledge_index 未返回正文");
      return this.vaultService.writeKnowledgeIndex(content + "\n");
    } finally {
      unsubscribe();
      await this.resetSession(scopeId);
    }
  }

  private async createEntry(
    scopeId: string,
    chatType: HarnessEntry["chatType"],
    opts: { runId?: string },
  ): Promise<HarnessEntry> {
    const session = await this.repo.create({
      cwd: `${chatType}/${businessDateKey().slice(0, 7)}`,
    });

    const route =
      chatType === "consolidation" ||
      chatType === "knowledge_index" ||
      chatType === "daily_memory"
        ? this.routes.weekly
        : this.routes.companion;

    const isDiaryRound = chatType === "diary";
    const isConsolidation = chatType === "consolidation";
    const canEditProfile = isConsolidation;
    const snapshot = buildMemorySnapshot(this.db);
    const systemPrompt = appendSessionInstructions(
      buildSystemPrompt(snapshot),
      chatType,
    );

    let entry: HarnessEntry;

    const allTools: AgentTool[] = [
      createWriteEpisodeTool(this.diaryService, () => entry.currentEpisodeSource),
      createGetStorylineTool(this.memoryService),
      createCreateStorylineTool(this.memoryService, () => entry.runId),
      createAdvanceStorylineTool(this.memoryService, () => entry.runId),
      createSetStorylineStatusTool(this.memoryService, () => entry.runId),
      createMergeStorylinesTool(this.memoryService, () => entry.runId),
      createSearchMemoryTool(this.db),
      ...createKnowledgeTools(this.vaultService),
    ];

    if (this.channel && this.registry) {
      allTools.push(
        createSendCheckinTool(
          this.channel,
          this.registry,
          this.messageService,
        ),
      );
    }

    if (canEditProfile) {
      allTools.push(createUpdateProfileTool(this.memoryService, () => entry.runId));
    }

    const activeToolNames = activeToolNamesFor(chatType);

    const harness = new AgentHarness({
      env: this.env,
      session,
      model: route.model,
      tools: allTools,
      activeToolNames,
      systemPrompt,
      getApiKeyAndHeaders: async () => ({ apiKey: route.apiKey }),
      streamOptions: route.streamOptions,
      thinkingLevel: route.thinkingLevel,
    });

    if (isDiaryRound) {
      harness.on("tool_call", (event) => {
        if (event.toolName === "update_profile") {
          return { block: true, reason: "日记轮不可修改身份画像" };
        }
      });
    }

    entry = {
      harness,
      scopeId,
      chatType,
      routeName: route.name,
      modelId: route.model.id,
      runId: opts.runId,
      lastActivityAt: Date.now(),
      activeToolNames,
      segmentStartedAt: null,
      segmentEndedAt: null,
      currentEpisodeSource: null,
    };

    this.entries.set(scopeId, entry);
    return entry;
  }

  private installSessionFileNames(): void {
    const repo = this.repo as unknown as {
      getSessionsRoot(): Promise<string>;
      getSessionDir(cwd: string): Promise<string>;
      createSessionFilePath(
        cwd: string,
        sessionId: string,
        timestamp: string,
      ): Promise<string>;
    };
    const getSessionsRoot = repo.getSessionsRoot.bind(this.repo);

    // cwd 直接作为相对子路径（chatType/月份）嵌套分组，而不是被编码成扁平目录名。
    repo.getSessionDir = async (cwd) => {
      const joined = await this.env.joinPath([await getSessionsRoot(), cwd]);
      if (!joined.ok) throw joined.error;
      return joined.value;
    };

    repo.createSessionFilePath = async (cwd, sessionId) => {
      const sessionDir = await repo.getSessionDir(cwd);
      const joined = await this.env.joinPath([
        sessionDir,
        `${businessFileTimestamp()}_${sessionId}.jsonl`,
      ]);
      if (!joined.ok) throw joined.error;
      return joined.value;
    };
  }

}

function appendSessionInstructions(
  basePrompt: string,
  chatType: HarnessEntry["chatType"],
): string {
  // builtin 有各自的任务 prompt，不属于这套陪伴会话工具纪律。
  // 尤其周合并就是唯一自动写画像的路径，绝不能被“绝不修改身份画像”这句压住。
  if (
    chatType === "consolidation" ||
    chatType === "knowledge_index" ||
    chatType === "daily_memory"
  ) {
    return basePrompt;
  }

  if (chatType !== "diary") {
    const externalFactsInstruction = isWebSearchConfigured()
      ? "- 对不熟或可能过期的外部事实，先 web_search；对象是 URL 时用 fetch_article。"
      : "- 对象是 URL 时可用 fetch_article；未配置 web_search 时不要尝试网页搜索。";
    return `${basePrompt}

---
# 当前会话工具纪律
- 持续叙事线由 daily_memory 统一维护；普通对话不要直接写 storylines。
- 如用户明确要求收藏 URL，可先 fetch_article 再 save_to_garden。
${externalFactsInstruction}
- DM、主题群和话题中，当前话题明显可能命中已有知识时可以 grep_vault / read_vault，回答要短，不要整段搬运原文。
- 反应和普通对话蒸馏只写 episode，绝不修改身份画像。`;
  }

  return `${basePrompt}

---
# 当前会话：日记群
- 用户消息会带有场景标记：
  - [日记群新日记]：这是一条新的日记根消息，必须先调用 write_episode 工具把原文蒸馏成 episode。
  - [日记群追问]：这是用户在同一篇日记上下文里继续回复，不是新的日记；不要求调用 write_episode。
- 持续叙事线由 daily_memory 统一维护；当前会话只写 episode、必要时 search_memory。
- 对 [日记群新日记]，在完成必要工具调用前不要输出面向用户的回复文本；工具完成后再按 response_style 回应，长短随内容走，不强求简短也不硬凑长。
- 对 [日记群追问]，可以直接自然回复；需要检索时再调用 search_memory。
- 回应时：
  - 一篇日记里塞了好几件事，挑一两件最有嚼头的往深里走，其余至多带过，别每件都回一句。覆盖全等于偷懒。
  - 问问题要克制。看到盲点直接点出来，那是陈述不算提问；提问只在一个问题真能帮我往下想时才用，别每条都用问号收尾、也别一次摞一串。
  - 默认不给方案、不给清单、不把我的处境重构成「你要解决的问题」。只有我明显卡死、或这篇本身在问怎么办时，给一个最小、具体的下一步，只给一个。日记不是任务列表。`;
}

function activeToolNamesFor(chatType: HarnessEntry["chatType"]): string[] {
  if (chatType === "diary") {
    return ["write_episode", "search_memory"];
  }
  if (chatType === "consolidation") {
    return ["update_profile", "search_memory"];
  }
  if (chatType === "knowledge_index") {
    return ["read_vault"];
  }
  if (chatType === "daily_memory") {
    return [];
  }
  const tools = [
    "search_memory",
    "fetch_article",
    "save_to_garden",
    "grep_vault",
    "read_vault",
    "update_frontmatter",
    "promote",
  ];
  if (isWebSearchConfigured()) {
    tools.splice(1, 0, "web_search");
  }
  return tools;
}

function policyKeyForChatType(
  chatType: HarnessEntry["chatType"],
): keyof SessionPolicyConfig {
  if (chatType === "thread") return "thread";
  if (chatType === "topic") return "topic";
  if (chatType === "diary") return "diary";
  return "dm";
}

function shouldDistillOnClose(chatType: HarnessEntry["chatType"]): boolean {
  return chatType === "dm" || chatType === "topic" || chatType === "thread";
}
