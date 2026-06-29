import { JsonlSessionRepo, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { LarkChannel } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { DiaryService, type EpisodeSource } from "../diary/service.js";
import { MemoryService } from "../memory/service.js";
import { MessageService, type StoredMessage } from "../storage/messages.js";
import { VaultService } from "../knowledge/vault.js";
import { buildMemorySnapshot, buildSystemPrompt } from "./prompts.js";
import { genId, nowISO } from "../utils.js";
import type { AgentChatType, SessionPolicyConfig } from "../config.js";
import { DEFAULT_PROFILE, loadSetting } from "../config.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { logger } from "../log.js";
import {
  createSessionRepo,
  SessionRegistry,
  type AgentSessionRow,
} from "./sessions.js";
import { BaseAgent, OneShotAgent, type AgentCloseContext } from "./base.js";
import { ChatAgent } from "./agents/chat.js";
import { DiaryAgent } from "./agents/diary.js";
import { DistillAgent } from "./agents/distill.js";
import { KnowledgeIndexAgent } from "./agents/knowledge-index.js";
import {
  ScheduleAgent,
  type TaskSystemPrompt,
} from "./agents/schedule.js";
import {
  ConsolidationAgent,
  type ConsolidationRound,
} from "./agents/consolidation.js";
import {
  DailyMemoryDreamAgent,
  DailyMemoryNudgeAgent,
} from "./agents/daily-memory.js";
import { buildChatTail } from "./agents/chat.js";
import { HarnessFactory } from "./harnessFactory.js";
import type { HarnessModelProfile } from "./runtime.js";

const distillLog = logger("distill");
const taskLog = logger("schedule-agent");
const serviceLog = logger("harness");

export interface AgentServiceOptions {
  db: Database.Database;
  sessionsDir: string;
  profiles: Record<string, HarnessModelProfile>;
  chatTypes: Partial<Record<AgentChatType, string>>;
  channel?: LarkChannel;
  registry?: ChatRegistry;
  clock?: Clock;
}

export interface OpenAgentOptions {
  scopeId: string;
  message?: { replyTo?: string | null; rootId?: string | null };
  runId?: string;
}

export type PersistentAgentKind = "dm" | "topic" | "thread" | "diary";

export function isPersistentAgentKind(kind: string): kind is PersistentAgentKind {
  return kind === "dm" || kind === "topic" || kind === "thread" || kind === "diary";
}

export type TaskTool = string | AgentTool<any>;

export interface RunTaskOptions {
  system?: TaskSystemPrompt;
  tools?: TaskTool[];
  profile?: string;
}

export class AgentService {
  private active = new Map<string, BaseAgent>();
  private env: NodeExecutionEnv;
  private repo: JsonlSessionRepo;
  private diaryService: DiaryService;
  private memoryService: MemoryService;
  private messageService: MessageService;
  private vaultService: VaultService;
  private sessionRegistry: SessionRegistry;
  private harnessFactory: HarnessFactory;
  private db: Database.Database;
  private profiles: AgentServiceOptions["profiles"];
  private chatTypes: AgentServiceOptions["chatTypes"];
  private clock: Clock;
  private scopeLocks = new Map<string, Promise<unknown>>();
  private cachedPolicy?: SessionPolicyConfig;

  constructor(opts: AgentServiceOptions) {
    this.db = opts.db;
    this.profiles = opts.profiles;
    this.chatTypes = opts.chatTypes;
    this.clock = opts.clock ?? systemClock;
    this.env = new NodeExecutionEnv({ cwd: process.cwd() });
    this.repo = createSessionRepo(this.env, opts.sessionsDir);
    this.diaryService = new DiaryService(opts.db, this.clock);
    this.memoryService = new MemoryService(opts.db, this.clock);
    this.messageService = new MessageService(opts.db, this.clock);
    this.vaultService = new VaultService();
    this.sessionRegistry = new SessionRegistry(opts.db);
    this.harnessFactory = new HarnessFactory({
      env: this.env,
      repo: this.repo,
      sessionsDir: opts.sessionsDir,
      profiles: this.profiles,
      chatTypes: this.chatTypes,
      diaryService: this.diaryService,
      memoryService: this.memoryService,
      messageService: this.messageService,
      vaultService: this.vaultService,
      sessionRegistry: this.sessionRegistry,
      db: this.db,
      channel: opts.channel,
      registry: opts.registry,
    });
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

  getSessionRegistry(): SessionRegistry {
    return this.sessionRegistry;
  }

  getClock(): Clock {
    return this.clock;
  }

  async open(
    kind: PersistentAgentKind,
    opts: OpenAgentOptions,
  ): Promise<BaseAgent> {
    if (opts.message) {
      return this.getOrCreateForMessage(kind, {
        scopeId: opts.scopeId,
        message: opts.message,
      });
    }
    return this.getOrCreate(opts.scopeId, kind, { runId: opts.runId });
  }

  async getOrCreate(
    scopeId: string,
    chatType: PersistentAgentKind,
    opts: { runId?: string } = {},
  ): Promise<BaseAgent> {
    const existing = this.active.get(scopeId);
    if (existing) {
      existing.touchActivity();
      if (opts.runId) existing.setRunId(opts.runId);
      return existing;
    }
    const agent = this.createPersistentAgent(chatType);
    return this.makeAgent(scopeId, {
      agent,
      runId: opts.runId,
      registerToRegistry: false,
    });
  }

  async getOrCreateForMessage(
    chatType: PersistentAgentKind,
    opts: {
      scopeId: string;
      message: { replyTo?: string | null; rootId?: string | null };
    },
  ): Promise<BaseAgent> {
    return this.withScopeLock(opts.scopeId, () =>
      this.getOrCreateForMessageInLock(opts.scopeId, chatType, opts.message),
    );
  }

  async getOrCreateForMessageInLock(
    scopeId: string,
    chatType: PersistentAgentKind,
    message: { replyTo?: string | null; rootId?: string | null },
  ): Promise<BaseAgent> {
    const active = this.active.get(scopeId);
    if (active) {
      active.touchActivity();
      return active;
    }

    const anchorMessageId = message.replyTo ?? message.rootId ?? null;
    const replyTarget = anchorMessageId
      ? this.sessionRegistry.findByMessageId(anchorMessageId)
      : null;
    if (replyTarget && replyTarget.scope_id === scopeId) {
      return await this.reopenForReplyTarget(replyTarget);
    }

    const unclosed = this.sessionRegistry.findUnclosedForScope(scopeId);
    if (unclosed) {
      if (!isPersistentAgentKind(unclosed.chat_type)) {
        serviceLog.warn(
          `关闭非持久型遗留 session=${unclosed.id} chat_type=${unclosed.chat_type}`,
        );
        this.sessionRegistry.markClosed(unclosed.id);
      } else if (!this.isUnclosedExpired(unclosed)) {
        return await this.restoreUnclosed(unclosed);
      } else {
        this.sessionRegistry.markClosed(unclosed.id);
      }
    }

    const agent = this.createPersistentAgent(chatType);
    return await this.makeAgent(scopeId, {
      agent,
      registerToRegistry: true,
    });
  }

  recordUserMessage(
    scopeId: string,
    messageId: string,
    occurredAt: string,
  ): void {
    const agent = this.active.get(scopeId);
    if (!agent?.sessionRowId) return;
    this.sessionRegistry.recordMessageEntry({
      messageId,
      sessionId: agent.sessionRowId,
      entryId: null,
      scopeId,
      role: "user",
      occurredAt,
    });
    this.sessionRegistry.updateSegmentWindow(agent.sessionRowId, occurredAt);
  }

  recordAssistantMessage(
    scopeId: string,
    messageId: string,
    occurredAt: string,
  ): void {
    const agent = this.active.get(scopeId);
    if (!agent?.sessionRowId) return;
    this.sessionRegistry.recordMessageEntry({
      messageId,
      sessionId: agent.sessionRowId,
      entryId: null,
      scopeId,
      role: "assistant",
      occurredAt,
    });
  }

  recordActivity(scopeId: string, createdAt: string): void {
    this.active.get(scopeId)?.recordActivity(createdAt);
  }

  setCurrentEpisodeSource(scopeId: string, source: EpisodeSource | null): void {
    this.active.get(scopeId)?.setEpisodeSource(source);
  }

  async resetSession(scopeId: string): Promise<void> {
    await this.withScopeLock(scopeId, async () => {
      const agent = this.active.get(scopeId);
      if (!agent) return;
      await agent.onClose(this.closeContext());
      if (agent.sessionRowId) {
        this.sessionRegistry.markClosed(agent.sessionRowId);
      }
      this.active.delete(scopeId);
    });
  }

  async compactSession(scopeId: string): Promise<void> {
    await this.withScopeLock(scopeId, async () => {
      const agent = this.active.get(scopeId);
      if (!agent) return;
      await agent.onClose(this.closeContext());
      if (agent.sessionRowId) {
        this.sessionRegistry.markClosed(agent.sessionRowId);
      }
      this.active.delete(scopeId);
      await agent.compact();
    });
  }

  async cleanupIdle(policy: SessionPolicyConfig): Promise<void> {
    const now = Date.now();
    const candidateScopes = Array.from(this.active.keys());
    for (const scopeId of candidateScopes) {
      await this.withScopeLock(scopeId, async () => {
        const agent = this.active.get(scopeId);
        if (!agent) return;
        const policyKey = agent.policyKey;
        if (!policyKey) return;
        const item = policy[policyKey];
        if (!item.autoClose || !item.idleMinutes) return;
        if (now - agent.lastActivityAt <= item.idleMinutes * 60_000) return;
        await agent.onClose(this.closeContext());
        if (agent.sessionRowId) {
          this.sessionRegistry.markClosed(agent.sessionRowId);
        }
        this.active.delete(scopeId);
      });
    }
  }

  async runKnowledgeIndexBuiltin(): Promise<string> {
    return this.withOneShotAgent(
      this.createKnowledgeIndexAgent(),
      (agent) => agent.run(),
    );
  }

  async runTask(prompt: string, opts: RunTaskOptions = {}): Promise<string> {
    const tools = opts.tools ?? [];
    const customTools = tools.filter(isAgentTool);
    for (const tool of customTools) {
      if (typeof tool.name !== "string" || !tool.name.trim()) {
        throw new Error("自定义工具缺少 name");
      }
      if (typeof tool.execute !== "function") {
        throw new Error(`自定义工具缺少 execute：${tool.name}`);
      }
    }

    const agent = new ScheduleAgent({
      system: this.resolveTaskSystemPrompt(opts.system ?? "bare"),
      profileName: this.resolveTaskProfileName(opts.profile),
      activeToolNames: tools.map((tool) =>
        typeof tool === "string" ? tool : tool.name,
      ),
      extraTools: customTools,
    });
    return this.withOneShotAgent(agent, (a) => a.run(prompt));
  }

  async runConsolidationMain(
    prompt: string,
    opts: { runId: string; defaultTools?: ReadonlyArray<string> },
  ): Promise<{ text: string; modelId: string }> {
    return this.withOneShotAgent(
      this.createConsolidationAgent(opts.defaultTools ?? ["search_memory"]),
      async (agent) => ({
        text: await agent.runMain(prompt),
        modelId: agent.modelId,
      }),
      { runId: opts.runId },
    );
  }

  async runConsolidationFriend(
    prompt: string,
    opts: { runId: string },
  ): Promise<string> {
    return this.withOneShotAgent(
      this.createConsolidationAgent([], "friend"),
      (agent) => agent.runFriend(prompt),
      { runId: opts.runId },
    );
  }

  async runDailyMemoryDream(
    prompt: string,
    opts: { runId: string; scopeId: string },
  ): Promise<string> {
    return this.withOneShotAgent(
      new DailyMemoryDreamAgent(this.db, this.memoryService),
      (agent) => agent.run(prompt),
      opts,
    );
  }

  async runDailyMemoryNudge(
    prompt: string,
    opts: { runId: string; scopeId: string },
  ): Promise<{ sent: boolean; text: string | null }> {
    return this.withOneShotAgent(
      new DailyMemoryNudgeAgent(this.db, this.memoryService),
      (agent) => agent.run(prompt),
      opts,
    );
  }

  async withOneShotAgent<A extends OneShotAgent, R>(
    agent: A,
    fn: (agent: A) => Promise<R>,
    opts: { runId?: string; scopeId?: string } = {},
  ): Promise<R> {
    const runId = opts.runId ?? genId("run");
    const scopeId = opts.scopeId ?? `${agent.scopeName}_${runId}`;
    if (agent.sessionPolicyKey()) {
      throw new Error(`withOneShotAgent 不接受 persistent chatType=${agent.chatType}`);
    }
    await this.makeAgent(scopeId, {
      agent,
      runId,
      registerToRegistry: false,
      profileName: agent.profileName,
      extraTools: agent.extraTools,
    });
    try {
      return await fn(agent);
    } finally {
      await this.disposeActiveAgent(scopeId);
    }
  }

  withScopeLock<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.scopeLocks.get(scopeId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const released = next.catch(() => undefined);
    this.scopeLocks.set(scopeId, released);
    released.finally(() => {
      if (this.scopeLocks.get(scopeId) === released) {
        this.scopeLocks.delete(scopeId);
      }
    });
    return next;
  }

  private async disposeActiveAgent(scopeId: string): Promise<void> {
    const agent = this.active.get(scopeId);
    if (!agent) return;
    await agent.onClose(this.closeContext());
    if (agent.sessionRowId) {
      this.sessionRegistry.markClosed(agent.sessionRowId);
    }
    this.active.delete(scopeId);
  }

  private async reopenForReplyTarget(target: AgentSessionRow): Promise<BaseAgent> {
    const others = this.sessionRegistry.findOtherOpenSessions(
      target.scope_id,
      target.id,
    );
    for (const other of others) {
      if (!isPersistentAgentKind(other.chat_type)) {
        serviceLog.warn(
          `跳过非持久型 session=${other.id} chat_type=${other.chat_type}`,
        );
        continue;
      }
      if (this.isUnclosedExpired(other)) continue;
      if (!other.segment_started_at || !other.segment_ended_at) continue;
      const agent = this.createPersistentAgent(other.chat_type);
      await agent.onStoredSessionClose(this.closeContext(), {
        scopeId: other.scope_id,
        startedAt: other.segment_started_at,
        endedAt: other.segment_ended_at,
      });
    }

    this.sessionRegistry.reopenWithExclusivity(target.id, target.scope_id, {
      resetSegment: target.status === "closed",
    });

    const refreshed = this.sessionRegistry.get(target.id)!;
    if (!isPersistentAgentKind(refreshed.chat_type)) {
      throw new Error(
        `session=${refreshed.id} chat_type=${refreshed.chat_type} 不是持久型，无法恢复`,
      );
    }
    return await this.makeAgent(refreshed.scope_id, {
      agent: this.createPersistentAgent(refreshed.chat_type),
      registerToRegistry: true,
      reopenRow: refreshed,
    });
  }

  private async restoreUnclosed(row: AgentSessionRow): Promise<BaseAgent> {
    if (!isPersistentAgentKind(row.chat_type)) {
      throw new Error(
        `session=${row.id} chat_type=${row.chat_type} 不是持久型，无法恢复`,
      );
    }
    return await this.makeAgent(row.scope_id, {
      agent: this.createPersistentAgent(row.chat_type),
      registerToRegistry: true,
      reopenRow: row,
    });
  }

  private isUnclosedExpired(row: AgentSessionRow): boolean {
    const item = this.getPolicyForChatType(row.chat_type);
    if (!item) return false;
    if (!item.autoClose || !item.idleMinutes) return false;
    const last = Date.parse(row.last_activity_at);
    if (!Number.isFinite(last)) return false;
    return Date.now() - last > item.idleMinutes * 60_000;
  }

  private getPolicyForChatType(chatType: AgentChatType) {
    if (!this.cachedPolicy) {
      this.cachedPolicy = loadSetting().sessions.policies;
    }
    if (!isPersistentAgentKind(chatType)) return undefined;
    const key = this.createPersistentAgent(chatType).sessionPolicyKey();
    return key ? this.cachedPolicy[key] : undefined;
  }

  private async makeAgent(
    scopeId: string,
    opts: Parameters<HarnessFactory["create"]>[1],
  ): Promise<BaseAgent> {
    const runtime = await this.harnessFactory.create(scopeId, opts);
    opts.agent.attach(runtime);
    this.active.set(scopeId, opts.agent);
    return opts.agent;
  }

  private closeContext(): AgentCloseContext {
    return {
      diaryService: this.diaryService,
      memoryService: this.memoryService,
      messageService: this.messageService,
      distill: async (source, messages) => {
        try {
          await this.withOneShotAgent(
            new DistillAgent(source, this.db, this.memoryService),
            (agent) => agent.run(messages),
          );
        } catch (err) {
          distillLog.warn(`scope=${source.conversationId} 蒸馏失败`, err);
          throw err;
        }
      },
    };
  }

  private resolveTaskProfileName(profileName?: string): string {
    if (!profileName) return DEFAULT_PROFILE;
    if (this.profiles[profileName]) return profileName;
    taskLog.warn(`未找到 schedule profile=${profileName}，回退 ${DEFAULT_PROFILE}`);
    return DEFAULT_PROFILE;
  }

  private resolveTaskSystemPrompt(system: TaskSystemPrompt): string {
    if (system === "bare") {
      return `你是一个定时任务 Agent。按任务要求完成工作，输出可以直接发送给用户的 Markdown 正文。
不要编造工具结果；如果任务要求通过工具提交结构化选择，必须调用对应工具。`;
    }
    if (system === "mori") {
      this.memoryService.syncEditableMemoryFiles();
      const snapshot = buildMemorySnapshot(this.db, this.memoryService);
      return buildSystemPrompt(snapshot) + buildChatTail();
    }
    return system;
  }

  private createPersistentAgent(kind: PersistentAgentKind): BaseAgent {
    switch (kind) {
      case "dm":
      case "topic":
      case "thread":
        return new ChatAgent(kind, this.db, this.memoryService);
      case "diary":
        return new DiaryAgent(this.db, this.memoryService);
    }
  }

  private createKnowledgeIndexAgent(): KnowledgeIndexAgent {
    return new KnowledgeIndexAgent(
      this.vaultService,
      this.db,
      this.memoryService,
    );
  }

  private createConsolidationAgent(
    defaultTools: ReadonlyArray<string>,
    round: ConsolidationRound = "main",
  ): ConsolidationAgent {
    return new ConsolidationAgent(
      defaultTools,
      this.db,
      this.memoryService,
      round,
    );
  }
}

function isAgentTool(tool: TaskTool): tool is AgentTool<any> {
  return typeof tool === "object" && tool !== null;
}
