import {
  AgentHarness,
  JsonlSessionRepo,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type Database from "better-sqlite3";
import { DiaryService, type EpisodeSource } from "../diary/service.js";
import { ApprovalService } from "../memory/approvals.js";
import { MemoryService } from "../memory/service.js";
import { MessageService, splitScopeId } from "../storage/messages.js";
import { VaultService } from "../knowledge/vault.js";
import { buildMemorySnapshot, buildSystemPrompt } from "./prompts.js";
import { createWriteEpisodeTool } from "./tools/write-episode.js";
import {
  createCreateWorkingItemTool,
  createMergeWorkingItemsTool,
  createUpdateWorkingItemTool,
} from "./tools/working-items.js";
import { createUpdateProfileTool } from "./tools/update-profile.js";
import { createSearchDiaryTool } from "./tools/search-diary.js";
import { createKnowledgeTools } from "./tools/knowledge.js";
import { genId, shanghaiFileTimestamp } from "../utils.js";
import type { SessionPolicyConfig } from "../config.js";
import type { UpdateWorkingItemData } from "./schemas.js";

const SESSION_CWD = "personal-agent";

export interface HarnessEntry {
  harness: AgentHarness;
  scopeId: string;
  chatType: "diary" | "dm" | "topic" | "thread" | "consolidation" | "knowledge_index";
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
}

export interface HarnessManagerOptions {
  db: Database.Database;
  sessionsDir: string;
  routes: {
    companion: HarnessModelRoute;
    weekly: HarnessModelRoute;
  };
}

export class HarnessManager {
  private entries = new Map<string, HarnessEntry>();
  private env: NodeExecutionEnv;
  private repo: JsonlSessionRepo;
  private diaryService: DiaryService;
  private memoryService: MemoryService;
  private approvalService: ApprovalService;
  private messageService: MessageService;
  private vaultService: VaultService;
  private db: Database.Database;
  private routes: HarnessManagerOptions["routes"];
  private consolidationUpdatePlans = new Map<string, UpdateWorkingItemData[]>();

  constructor(opts: HarnessManagerOptions) {
    this.db = opts.db;
    this.routes = opts.routes;
    this.env = new NodeExecutionEnv({ cwd: process.cwd() });
    this.repo = new JsonlSessionRepo({
      fs: this.env,
      sessionsRoot: opts.sessionsDir,
    });
    this.installShanghaiSessionFileNames();
    this.diaryService = new DiaryService(opts.db);
    this.memoryService = new MemoryService(opts.db);
    this.approvalService = new ApprovalService(opts.db);
    this.messageService = new MessageService(opts.db);
    this.vaultService = new VaultService();
  }

  getDiaryService(): DiaryService {
    return this.diaryService;
  }

  getMemoryService(): MemoryService {
    return this.memoryService;
  }

  getApprovalService(): ApprovalService {
    return this.approvalService;
  }

  getMessageService(): MessageService {
    return this.messageService;
  }

  getVaultService(): VaultService {
    return this.vaultService;
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
      scopeId,
      messageId: null,
      startedAt: entry.segmentStartedAt,
      endedAt: entry.segmentEndedAt,
    };
    if (this.diaryService.hasEpisodeForScopeWindow(source)) return;

    const messages = this.messageService.getScopeMessages(
      scopeId,
      source.startedAt,
      source.endedAt,
    );
    if (!messages.some((message) => message.role === "user")) return;

    const restoreToolNames = [...entry.activeToolNames];
    entry.currentEpisodeSource = source;
    const transcript = messages
      .map((message) => `[${message.created_at}] ${message.role}: ${message.content}`)
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
    const session = await this.repo.create({ cwd: SESSION_CWD });

    const route =
      chatType === "consolidation" || chatType === "knowledge_index"
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
      createCreateWorkingItemTool(this.memoryService),
      createUpdateWorkingItemTool(this.memoryService, {
        approvalService: isConsolidation ? this.approvalService : undefined,
        planUpdate: isConsolidation
          ? (params) =>
            this.planConsolidationWorkingItemUpdate(
              entry.runId ?? entry.scopeId,
              params,
            )
          : undefined,
        getChatId: () => chatIdForApproval(entry.scopeId),
        getRunId: () => entry.runId,
      }),
      createMergeWorkingItemsTool(this.approvalService, {
        getChatId: () => chatIdForApproval(entry.scopeId),
        getRunId: () => entry.runId,
      }),
      createSearchDiaryTool(this.db),
      ...createKnowledgeTools(this.vaultService),
    ];

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
      streamOptions: { cacheRetention: "long" },
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

  private installShanghaiSessionFileNames(): void {
    const repo = this.repo as unknown as {
      getSessionDir(cwd: string): Promise<string>;
      createSessionFilePath(
        cwd: string,
        sessionId: string,
        timestamp: string,
      ): Promise<string>;
    };
    const getSessionDir = repo.getSessionDir.bind(this.repo);

    repo.createSessionFilePath = async (cwd, sessionId) => {
      const sessionDir = await getSessionDir(cwd);
      const joined = await this.env.joinPath([
        sessionDir,
        `${shanghaiFileTimestamp()}_${sessionId}.jsonl`,
      ]);
      if (!joined.ok) throw joined.error;
      return joined.value;
    };
  }

  finalizeConsolidationWorkingItemUpdates(runId: string): string[] {
    const updates = this.consolidationUpdatePlans.get(runId) ?? [];
    this.consolidationUpdatePlans.delete(runId);
    if (updates.length === 0) return [];

    const needsApproval =
      updates.length >= 3 ||
      updates.some((update) => isHighImpactWorkingItemStatus(update.status));
    if (!needsApproval) {
      for (const update of updates) {
        this.memoryService.updateWorkingItem(update);
      }
      return [];
    }

    const approvalId = this.approvalService.createPending({
      toolName: "batch_update_working_items",
      payload: {
        tool_name: "batch_update_working_items",
        data: { updates },
        reason: updates.length >= 3
          ? `周总结/手动合并计划批量更新 ${updates.length} 个工作集`
          : "周总结/手动合并包含高影响工作集状态变更",
      },
      runId,
    });
    return [approvalId];
  }

  discardConsolidationWorkingItemUpdates(runId: string): void {
    this.consolidationUpdatePlans.delete(runId);
  }

  private planConsolidationWorkingItemUpdate(
    runKey: string,
    params: UpdateWorkingItemData,
  ): number {
    const updates = this.consolidationUpdatePlans.get(runKey) ?? [];
    updates.push(cloneWorkingItemUpdate(params));
    this.consolidationUpdatePlans.set(runKey, updates);
    return updates.length;
  }
}

function appendSessionInstructions(
  basePrompt: string,
  chatType: HarnessEntry["chatType"],
): string {
  if (chatType !== "diary") {
    return `${basePrompt}

---
# 当前会话工具纪律
- 工作集更新已有条目必须使用 snapshot 里的 id 调 update_working_item；没有 id 时只能 create_working_item。
- 如用户明确要求收藏 URL，可先 fetch_article 再 save_to_garden。
- DM、主题群和话题中，当前话题明显可能命中已有知识时可以 grep_vault / read_vault，回答要短，不要整段搬运原文。
- 反应和普通对话蒸馏只写 episode / 工作集，绝不修改身份画像。`;
  }

  return `${basePrompt}

---
# 当前会话：日记群
- 用户消息会带有场景标记：
  - [日记群新日记]：这是一条新的日记根消息，必须先调用 write_episode 工具把原文蒸馏成 episode。
  - [日记群追问]：这是用户在同一篇日记上下文里继续回复，不是新的日记；不要求调用 write_episode。
- 如果内容涉及正在推进的项目、开放问题或明确决策，新条目调用 create_working_item；更新已有条目必须用 snapshot 里的 id 调 update_working_item。
- 对 [日记群新日记]，在完成必要工具调用前不要输出面向用户的回复文本；工具完成后再简短回应。
- 对 [日记群追问]，可以直接自然回复；需要检索或更新工作集时再调用工具。`;
}

function isHighImpactWorkingItemStatus(status: string): boolean {
  return status === "dormant" || status === "done" || status === "dropped";
}

function cloneWorkingItemUpdate(params: UpdateWorkingItemData): UpdateWorkingItemData {
  return {
    ...params,
    current_questions: params.current_questions
      ? [...params.current_questions]
      : undefined,
    decisions: params.decisions ? [...params.decisions] : undefined,
    next_steps: params.next_steps ? [...params.next_steps] : undefined,
    related_people: params.related_people ? [...params.related_people] : undefined,
  };
}

function activeToolNamesFor(chatType: HarnessEntry["chatType"]): string[] {
  if (chatType === "diary") {
    return ["write_episode", "create_working_item", "update_working_item", "search_diary"];
  }
  if (chatType === "consolidation") {
    return [
      "create_working_item",
      "update_working_item",
      "merge_working_items",
      "update_profile",
      "search_diary",
    ];
  }
  if (chatType === "knowledge_index") {
    return ["read_vault"];
  }
  return [
    "search_diary",
    "create_working_item",
    "update_working_item",
    "fetch_article",
    "save_to_garden",
    "grep_vault",
    "read_vault",
    "update_frontmatter",
    "promote",
  ];
}

function chatIdForApproval(scopeId: string): string | null {
  if (scopeId.startsWith("consolidation_")) return null;
  return splitScopeId(scopeId).chatId;
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
