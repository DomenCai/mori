import {
  AgentHarness,
  JsonlSessionRepo,
  type AgentTool,
  type AgentHarnessStreamOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type { LarkChannel } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { join, relative, isAbsolute } from "node:path";
import { DiaryService, type EpisodeSource } from "../diary/service.js";
import { MemoryService } from "../memory/service.js";
import { MessageService } from "../storage/messages.js";
import { VaultService } from "../knowledge/vault.js";
import { buildMemorySnapshot, buildSystemPrompt } from "./prompts.js";
import { installToolGuard, type ToolGuard } from "./toolGuard.js";
import { createWriteEpisodeTool } from "./tools/write-episode.js";
import {
  createAdvanceStorylineTool,
  createCreateStorylineTool,
  createGetStorylineTool,
  createMergeStorylinesTool,
  createSetStorylineStatusTool,
} from "./tools/storylines.js";
import { createUpdateProfileTool } from "./tools/update-profile.js";
import { createSetChapterTool } from "./tools/set-chapter.js";
import { createSearchMemoryTool } from "./tools/search-memory.js";
import { createSendCheckinTool } from "./tools/send-checkin.js";
import { createKnowledgeTools } from "./tools/knowledge.js";
import { isWebSearchConfigured } from "./tools/web-search.js";
import { genId, businessDateKey, businessFileTimestamp, nowISO } from "../utils.js";
import type { AgentChatType, SessionPolicyConfig } from "../config.js";
import { DEFAULT_PROFILE, loadSetting } from "../config.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import type { StoredMessage } from "../storage/messages.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { logger } from "../log.js";
import { SessionRegistry, type AgentSessionRow } from "./sessionRegistry.js";

const distillLog = logger("distill");
const taskLog = logger("schedule-agent");
const harnessLog = logger("harness");

// 一段会话窗口的用户输入总字数低于此值，视为寒暄/确认类废会话，关会话时不单独蒸馏。
const MIN_DISTILL_USER_CHARS = 80;

export interface HarnessEntry {
  harness: AgentHarness;
  scopeId: string;
  chatType: AgentChatType;
  /** 实际选中的档位名（normal / strong），调试用。 */
  profileName: string;
  modelId: string;
  runId?: string;
  lastActivityAt: number;
  activeToolNames: string[];
  toolGuard: ToolGuard;
  segmentStartedAt: string | null;
  segmentEndedAt: string | null;
  currentEpisodeSource: EpisodeSource | null;
  /** dm/topic/thread/diary 这类被恢复索引追踪的 session 才有；schedule/distill 等内部 scope 为 null。 */
  sessionRowId: string | null;
}

export interface HarnessModelProfile {
  name: string;
  model: Model<any>;
  apiKey: string;
  streamOptions: AgentHarnessStreamOptions;
}

export interface HarnessManagerOptions {
  db: Database.Database;
  sessionsDir: string;
  /** 已解析的档位：档位名 → 模型配置。 */
  profiles: Record<string, HarnessModelProfile>;
  /** chatType → 档位名；未列出的 chatType 走 DEFAULT_PROFILE。 */
  chatTypes: Partial<Record<AgentChatType, string>>;
  channel?: LarkChannel;
  registry?: ChatRegistry;
  clock?: Clock;
}

export type TaskSystemPrompt = "bare" | "mori" | string;
export type TaskTool = string | AgentTool<any>;

export interface RunTaskOptions {
  system?: TaskSystemPrompt;
  tools?: TaskTool[];
  profile?: string;
}

/** 哪些 chat type 进 agent_sessions 恢复索引：交互式会话才进。 */
function isPersistentChatType(chatType: AgentChatType): boolean {
  return chatType === "dm" || chatType === "topic" || chatType === "thread" || chatType === "diary";
}

interface CreateEntryInternalOptions {
  runId?: string;
  activeToolNames?: string[];
  extraTools?: AgentTool<any>[];
  profileName?: string;
  /** schedule / distill 等一次性任务用：直接覆写 system prompt 字符串。 */
  systemPromptOverride?: string;
  /** 是否把此 session 登记进 SessionRegistry（仅 dm/topic/thread/diary 应为 true）。 */
  registerToRegistry: boolean;
  /** 从已有 row 恢复时传入。 */
  reopenRow?: AgentSessionRow;
}

export class HarnessManager {
  private entries = new Map<string, HarnessEntry>();
  private env: NodeExecutionEnv;
  private repo: JsonlSessionRepo;
  private diaryService: DiaryService;
  private memoryService: MemoryService;
  private messageService: MessageService;
  private vaultService: VaultService;
  private sessionRegistry: SessionRegistry;
  private db: Database.Database;
  private sessionsDir: string;
  private profiles: HarnessManagerOptions["profiles"];
  private chatTypes: HarnessManagerOptions["chatTypes"];
  private channel?: LarkChannel;
  private registry?: ChatRegistry;
  private clock: Clock;
  /** per-scope 串行队列：保证 getOrCreateForMessage / harness.prompt / idle close / reply-target reopen 不并发。 */
  private scopeLocks = new Map<string, Promise<unknown>>();

  constructor(opts: HarnessManagerOptions) {
    this.db = opts.db;
    this.sessionsDir = opts.sessionsDir;
    this.profiles = opts.profiles;
    this.chatTypes = opts.chatTypes;
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
    this.sessionRegistry = new SessionRegistry(opts.db);
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

  getSessionRegistry(): SessionRegistry {
    return this.sessionRegistry;
  }

  getClock(): Clock {
    return this.clock;
  }

  /**
   * 内部 / 兜底入口。
   *
   * 飞书 dm / topic / thread / diary 消息走 getOrCreateForMessage，会写恢复索引；
   * 这里只服务两类场景：
   *   1. 内部一次性 scope（schedule / distill / daily_memory / consolidation / knowledge_index）。
   *   2. backfill / diary entry 重入：scope 已经在内存里时直接复用现有 entry。
   *
   * 命中现有 entry 时只刷活动时间；未命中且不是交互式 chatType 时新建一个不登记 registry 的 entry。
   * 未命中且是交互式 chatType 时也允许新建（只对 backfill 等带自定义 sessionScope 的路径开放），
   * 同样不登记 registry——避免一次性导入污染恢复索引。
   */
  async getOrCreate(
    scopeId: string,
    chatType: AgentChatType,
    opts: {
      runId?: string;
      activeToolNames?: string[];
      extraTools?: AgentTool<any>[];
      profileName?: string;
      systemPrompt?: string;
    } = {},
  ): Promise<HarnessEntry> {
    const existing = this.entries.get(scopeId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      existing.runId = opts.runId ?? existing.runId;
      return existing;
    }
    return this.createEntry(scopeId, chatType, {
      runId: opts.runId,
      activeToolNames: opts.activeToolNames,
      extraTools: opts.extraTools,
      profileName: opts.profileName,
      systemPromptOverride: opts.systemPrompt,
      registerToRegistry: false,
    });
  }

  /**
   * 飞书消息入口：dm / topic / thread / diary 走这条。
   * 按设计文档的恢复算法选择 active / reply-target / unclosed / new。
   *
   * 注意：此方法自己拿一次 scope lock；如果 caller 已经在 `withScopeLock` 里，
   * 应该用 `getOrCreateForMessageInLock` 跳过外层锁，避免同 scope 自锁死。
   */
  async getOrCreateForMessage(
    scopeId: string,
    chatType: AgentChatType,
    message: { replyTo?: string | null; rootId?: string | null },
  ): Promise<HarnessEntry> {
    if (!isPersistentChatType(chatType)) {
      throw new Error(`chatType=${chatType} 不应走 getOrCreateForMessage`);
    }
    return this.withScopeLock(scopeId, () =>
      this.getOrCreateForMessageInLock(scopeId, chatType, message),
    );
  }

  /** 已在 scope lock 内的入口；与 `getOrCreateForMessage` 等价但不再加锁。 */
  async getOrCreateForMessageInLock(
    scopeId: string,
    chatType: AgentChatType,
    message: { replyTo?: string | null; rootId?: string | null },
  ): Promise<HarnessEntry> {
    if (!isPersistentChatType(chatType)) {
      throw new Error(`chatType=${chatType} 不应走 getOrCreateForMessage`);
    }
    const active = this.entries.get(scopeId);
    if (active) {
      active.lastActivityAt = Date.now();
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
      if (!this.isUnclosedExpired(unclosed)) {
        return await this.restoreUnclosed(unclosed);
      }
      // 过期：只标 closed，不补跑停机期间错过的蒸馏。
      this.sessionRegistry.markClosed(unclosed.id);
    }

    return await this.createEntry(scopeId, chatType, {
      registerToRegistry: true,
    });
  }

  /** 用户消息记录到 message_session_entries，并扩展 segment window。 */
  recordUserMessage(
    scopeId: string,
    messageId: string,
    occurredAt: string,
  ): void {
    const entry = this.entries.get(scopeId);
    if (!entry || !entry.sessionRowId) return;
    this.sessionRegistry.recordMessageEntry({
      messageId,
      sessionId: entry.sessionRowId,
      entryId: null,
      scopeId,
      role: "user",
      occurredAt,
    });
    this.sessionRegistry.updateSegmentWindow(entry.sessionRowId, occurredAt);
  }

  /** assistant 平台消息记录到 message_session_entries，便于将来按该 message 反查 session。 */
  recordAssistantMessage(
    scopeId: string,
    messageId: string,
    occurredAt: string,
  ): void {
    const entry = this.entries.get(scopeId);
    if (!entry || !entry.sessionRowId) return;
    this.sessionRegistry.recordMessageEntry({
      messageId,
      sessionId: entry.sessionRowId,
      entryId: null,
      scopeId,
      role: "assistant",
      occurredAt,
    });
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
    await this.withScopeLock(scopeId, async () => {
      await this.distillScopeEpisode(scopeId);
      const entry = this.entries.get(scopeId);
      if (entry?.sessionRowId) {
        this.sessionRegistry.markClosed(entry.sessionRowId);
      }
      this.entries.delete(scopeId);
    });
  }

  async compactSession(scopeId: string): Promise<void> {
    await this.withScopeLock(scopeId, async () => {
      await this.distillScopeEpisode(scopeId);
      const entry = this.entries.get(scopeId);
      if (!entry) return;
      if (entry.sessionRowId) {
        this.sessionRegistry.markClosed(entry.sessionRowId);
        // compact 之后内存还在，但 SQL 已 closed：清掉内存条目，下条消息走冷启动新建。
        // 这样语义清晰：compact 等于强制关现有 segment。
      }
      this.entries.delete(scopeId);
      await entry.harness.compact();
    });
  }

  async cleanupIdle(policy: SessionPolicyConfig): Promise<void> {
    const now = Date.now();
    const candidateScopes = Array.from(this.entries.keys());
    for (const scopeId of candidateScopes) {
      // 逐 scope 取锁，在锁内重新判断：避免 prompt 正在跑时把同一 session 误关。
      await this.withScopeLock(scopeId, async () => {
        const entry = this.entries.get(scopeId);
        if (!entry) return;
        const item = policy[policyKeyForChatType(entry.chatType)];
        if (!item.autoClose || !item.idleMinutes) return;
        if (now - entry.lastActivityAt <= item.idleMinutes * 60_000) return;
        await this.distillScopeEpisode(scopeId);
        if (entry.sessionRowId) {
          this.sessionRegistry.markClosed(entry.sessionRowId);
        }
        this.entries.delete(scopeId);
      });
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
    // 不论后续蒸馏是否落库，这段窗口都算翻篇，避免下次关会话重复处理同一段。
    entry.segmentStartedAt = null;
    entry.segmentEndedAt = null;

    if (this.diaryService.hasEpisodeForScopeWindow(source)) return;

    const messages = this.messageService.getConversationMessages(
      scopeId,
      source.startedAt,
      source.endedAt,
    );
    if (!segmentWorthDistilling(messages)) return;

    await this.runEpisodeDistill(source, messages);
  }

  // 关会话蒸馏跑在一个独立的一次性 agent 里（工具集恒定为 [write_episode]），而不是
  // 劫持正在对话的 harness。对话 agent 因此不必内联写 episode、不必切工具，也不会自己
  // 引导自己；蒸馏只读用户消息和我的回复文本，不掺工具调用噪音。
  private async runEpisodeDistill(
    source: EpisodeSource,
    messages: StoredMessage[],
  ): Promise<void> {
    const transcript = messages
      .map(
        (m) =>
          `[${m.occurred_at}] ${m.role === "user" ? "用户" : "我"}: ${m.content}`,
      )
      .join("\n\n");

    const runId = genId("run");
    const distillScope = `distill_${runId}`;
    const entry = await this.getOrCreate(distillScope, "distill", { runId });
    entry.currentEpisodeSource = source;
    try {
      await entry.harness.prompt(`# 会话片段蒸馏

下面是一段已经结束的对话，只含用户消息和我的回复。请判断其中是否有和用户长期上下文有关的事实、判断、行动、偏好信号：
- 有，就只调用 write_episode 蒸馏成一条 episode（每条 observation 带原文 evidence）。
- 没有值得长期记的内容，就什么工具都不要调用，直接结束。
不要输出面向用户的回复文本，不要修改身份画像。

${transcript}`);
    } catch (err) {
      // 蒸馏失败不落兜底 episode：原始消息已在 messages 表里留底，宁可这次漏记，
      // 也不要把整段 transcript 当 episode 塞进证据层污染检索。
      distillLog.warn(`scope=${source.conversationId} 蒸馏失败`, err);
    } finally {
      await this.resetSession(distillScope);
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

  async runTask(prompt: string, opts: RunTaskOptions = {}): Promise<string> {
    const runId = genId("run");
    const scopeId = `schedule_${runId}`;
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
    const activeToolNames = tools.map((tool) =>
      typeof tool === "string" ? tool : tool.name,
    );
    const entry = await this.getOrCreate(scopeId, "schedule", {
      runId,
      activeToolNames,
      extraTools: customTools,
      profileName: this.resolveTaskProfileName(opts.profile),
      systemPrompt: this.resolveTaskSystemPrompt(opts.system ?? "bare"),
    });

    let text = "";
    const unsubscribe = entry.harness.subscribe(async (event) => {
      if (event.type === "turn_end" && !assistantMessageHasToolCall(event.message)) {
        text = assistantMessageText(event.message);
      }
    });

    try {
      await entry.harness.prompt(prompt);
      return text.trim();
    } finally {
      unsubscribe();
      await this.resetSession(scopeId);
    }
  }

  /**
   * reply-target 冷启动恢复：
   *   1. 在锁内对同 scope 其它未过期 open session 做 best-effort 蒸馏。
   *   2. 单事务先 close others 再 reopen target。
   *   3. 物理打开 JSONL 并装入新 harness。
   */
  private async reopenForReplyTarget(target: AgentSessionRow): Promise<HarnessEntry> {
    const others = this.sessionRegistry.findOtherOpenSessions(
      target.scope_id,
      target.id,
    );
    for (const other of others) {
      if (!shouldDistillOnClose(other.chat_type)) continue;
      if (this.isUnclosedExpired(other)) continue;
      if (!other.segment_started_at || !other.segment_ended_at) continue;
      const source: EpisodeSource = {
        conversationId: other.scope_id,
        messageId: null,
        startedAt: other.segment_started_at,
        endedAt: other.segment_ended_at,
      };
      try {
        if (!this.diaryService.hasEpisodeForScopeWindow(source)) {
          const messages = this.messageService.getConversationMessages(
            source.conversationId,
            source.startedAt,
            source.endedAt,
          );
          if (segmentWorthDistilling(messages)) {
            await this.runEpisodeDistill(source, messages);
          }
        }
      } catch (err) {
        // 蒸馏失败只 warn，不阻断 reopen。
        distillLog.warn(
          `reopen 抢占同 scope 蒸馏失败 scope=${other.scope_id} session=${other.id}`,
          err,
        );
      }
    }

    // SQL 事务严格按设计 4 步顺序：close others → open target。
    // target 原本 closed 才清 segment（开启新窗口）；target 已 open 时是幂等 reopen，
    // 保留尚未蒸馏的 segment 窗口。
    this.sessionRegistry.reopenWithExclusivity(target.id, target.scope_id, {
      resetSegment: target.status === "closed",
    });

    const refreshed = this.sessionRegistry.get(target.id)!;
    return await this.createEntry(refreshed.scope_id, refreshed.chat_type, {
      registerToRegistry: true,
      reopenRow: refreshed,
    });
  }

  /** 进程重启恢复 unclosed session：保留原 segment window，只刷活动时间。 */
  private async restoreUnclosed(row: AgentSessionRow): Promise<HarnessEntry> {
    return await this.createEntry(row.scope_id, row.chat_type, {
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

  /**
   * 当前进程的 session policy。第一版直接读 setting；
   * 为避免循环依赖在 createEntry 时把 policy 注进来太重，先按需 lazy 读。
   */
  private getPolicyForChatType(chatType: AgentChatType) {
    if (!this.cachedPolicy) {
      this.cachedPolicy = loadSetting().sessions.policies;
    }
    return this.cachedPolicy[policyKeyForChatType(chatType)];
  }
  private cachedPolicy?: SessionPolicyConfig;

  private async createEntry(
    scopeId: string,
    chatType: AgentChatType,
    opts: CreateEntryInternalOptions,
  ): Promise<HarnessEntry> {
    const reopenRow = opts.reopenRow;
    const cwd = reopenRow
      ? reopenRow.cwd
      : `${chatType}/${businessDateKey().slice(0, 7)}`;

    // 选 profile：恢复时优先用归档 profile，缺失则降级到当前配置默认。
    let profileName = opts.profileName ?? reopenRow?.profile_name ?? this.chatTypes[chatType] ?? DEFAULT_PROFILE;
    let profile = this.profiles[profileName];
    if (!profile) {
      const fallback = this.chatTypes[chatType] ?? DEFAULT_PROFILE;
      harnessLog.warn(
        `恢复 session=${reopenRow?.id ?? "(new)"} 找不到 profile=${profileName}，降级为 ${fallback}`,
      );
      profileName = fallback;
      profile = this.profiles[profileName];
      if (!profile) {
        throw new Error(`未找到模型档位: ${profileName}（chatType=${chatType}）`);
      }
    }

    const session = reopenRow
      ? await this.repo.open({
          id: "",
          createdAt: "",
          cwd: reopenRow.cwd,
          path: this.absSessionPath(reopenRow.session_path),
        })
      : await this.repo.create({ cwd });

    // 拿到 metadata 反推绝对路径，写库时落相对 sessionsDir。
    const metadata = await session.getMetadata();
    const absolutePath = metadata.path;
    const relativePath = this.toRelativeSessionPath(absolutePath);

    const isConsolidation = chatType === "consolidation";
    const canEditProfile = isConsolidation;

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
      allTools.push(createSetChapterTool(this.memoryService, () => entry.runId));
    }

    for (const tool of opts.extraTools ?? []) {
      if (allTools.some((existing) => existing.name === tool.name)) {
        throw new Error(`自定义工具名与内置工具冲突：${tool.name}`);
      }
      allTools.push(tool);
    }

    // active tool 名解析：先用恢复行的存档，过滤掉已不存在的工具；空则降级到当前默认。
    const activeToolNames = this.resolveActiveToolNames({
      explicit: opts.activeToolNames,
      reopenRow,
      chatType,
      allTools,
    });

    const memoryService = this.memoryService;
    const db = this.db;
    const useDynamicSystemPrompt = !opts.systemPromptOverride;

    const dynamicSystemPrompt = (): string => {
      memoryService.syncEditableMemoryFiles();
      const snapshot = buildMemorySnapshot(db, memoryService);
      return appendSessionInstructions(buildSystemPrompt(snapshot), chatType);
    };

    const harness = new AgentHarness({
      env: this.env,
      session,
      model: profile.model,
      tools: allTools,
      activeToolNames,
      systemPrompt: useDynamicSystemPrompt
        ? () => dynamicSystemPrompt()
        : opts.systemPromptOverride!,
      getApiKeyAndHeaders: async () => ({ apiKey: profile.apiKey }),
      streamOptions: profile.streamOptions,
    });

    let sessionRowId: string | null = null;
    let segmentStartedAt: string | null = null;
    let segmentEndedAt: string | null = null;
    if (opts.registerToRegistry) {
      if (reopenRow) {
        // unclosed 重启恢复：保留 segment window；reopenWithExclusivity 已清掉抢占场景的窗口。
        sessionRowId = reopenRow.id;
        segmentStartedAt = reopenRow.segment_started_at;
        segmentEndedAt = reopenRow.segment_ended_at;
        // 进程内重启需要刷新活动时间到现在，避免下一次过期判定基于停机前的旧值。
        this.sessionRegistry.touchActivity(reopenRow.id, nowISO());
      } else {
        const row = this.sessionRegistry.create({
          id: genId("agent_sess"),
          sessionPath: relativePath,
          cwd,
          scopeId,
          chatType,
          profileName: profile.name,
          modelId: profile.model.id,
          activeToolNames,
        });
        sessionRowId = row.id;
      }
    }

    entry = {
      harness,
      scopeId,
      chatType,
      profileName: profile.name,
      modelId: profile.model.id,
      runId: opts.runId,
      lastActivityAt: Date.now(),
      activeToolNames,
      toolGuard: installToolGuard(harness),
      segmentStartedAt,
      segmentEndedAt,
      currentEpisodeSource: null,
      sessionRowId,
    };

    this.entries.set(scopeId, entry);
    return entry;
  }

  private resolveActiveToolNames(opts: {
    explicit?: string[];
    reopenRow?: AgentSessionRow;
    chatType: AgentChatType;
    allTools: AgentTool[];
  }): string[] {
    const allNames = new Set(opts.allTools.map((t) => t.name));

    if (opts.explicit !== undefined) {
      const unknown = opts.explicit.filter((name) => !allNames.has(name));
      if (unknown.length > 0) {
        throw new Error(`未知工具：${unknown.join(", ")}`);
      }
      return opts.explicit;
    }

    if (opts.reopenRow) {
      try {
        const stored = JSON.parse(opts.reopenRow.active_tool_names_json) as unknown;
        if (Array.isArray(stored) && stored.every((v) => typeof v === "string")) {
          const filtered: string[] = [];
          for (const name of stored) {
            if (allNames.has(name)) filtered.push(name);
            else harnessLog.warn(
              `恢复 session=${opts.reopenRow.id} 工具 ${name} 已不存在，丢弃`,
            );
          }
          if (filtered.length > 0) return filtered;
          harnessLog.warn(
            `恢复 session=${opts.reopenRow.id} 工具集过滤后为空，降级为当前默认`,
          );
        } else {
          harnessLog.warn(
            `恢复 session=${opts.reopenRow.id} active_tool_names_json 不是字符串数组，降级`,
          );
        }
      } catch (err) {
        harnessLog.warn(
          `恢复 session=${opts.reopenRow.id} active_tool_names_json 解析失败，降级`,
          err,
        );
      }
    }

    const defaultNames = activeToolNamesFor(opts.chatType);
    const unknown = defaultNames.filter((name) => !allNames.has(name));
    if (unknown.length > 0) {
      throw new Error(`未知工具：${unknown.join(", ")}`);
    }
    return defaultNames;
  }

  private toRelativeSessionPath(absolutePath: string): string {
    if (!isAbsolute(absolutePath)) return absolutePath;
    return relative(this.sessionsDir, absolutePath);
  }

  private absSessionPath(stored: string): string {
    return isAbsolute(stored) ? stored : join(this.sessionsDir, stored);
  }

  /**
   * per-scope 串行队列：尾部接一个 promise，让后来者等前面跑完。
   * 飞书 handler 把 getOrCreateForMessage + harness.prompt + 消息登记整体包在这里，
   * 保证同 scope 的并发消息、idle close、reply-target reopen、`/new` 不互相穿插。
   */
  withScopeLock<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.scopeLocks.get(scopeId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    // 占位 promise 用 catch 包一层，防止失败被 caller 漏接导致后续永远卡住。
    const released = next.catch(() => undefined);
    this.scopeLocks.set(scopeId, released);
    released.finally(() => {
      if (this.scopeLocks.get(scopeId) === released) {
        this.scopeLocks.delete(scopeId);
      }
    });
    return next;
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
      return appendSessionInstructions(buildSystemPrompt(snapshot), "schedule");
    }
    return system;
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

function isAgentTool(tool: TaskTool): tool is AgentTool<any> {
  return typeof tool === "object" && tool !== null;
}

function assistantMessageHasToolCall(message: unknown): boolean {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const record = item as Record<string, unknown>;
    return record?.type === "toolCall";
  });
}

function assistantMessageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const record = item as Record<string, unknown>;
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
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
    chatType === "daily_memory" ||
    chatType === "distill"
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
  if (chatType === "distill") {
    return ["write_episode"];
  }
  if (chatType === "consolidation") {
    return ["update_profile", "set_chapter", "search_memory"];
  }
  if (chatType === "knowledge_index") {
    return ["read_vault"];
  }
  if (chatType === "daily_memory") {
    return [];
  }
  if (chatType === "schedule") {
    return [];
  }
  // 普通对话不写 episode（蒸馏交给独立 distill agent），所以工具集里不含 write_episode。
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

// 闸门：只有用户实质说了够多内容的窗口才值得开一次独立蒸馏。寒暄/确认类
// （"在吗""嗯""谢了"）字数不够，直接跳过，省下一次 LLM 调用。
// 用字数总和而非消息条数：既能挡住"多条短句"，也不会误杀"一条长倾诉"。
function segmentWorthDistilling(messages: StoredMessage[]): boolean {
  const userChars = messages
    .filter((m) => m.role === "user")
    .reduce((sum, m) => sum + m.content.trim().length, 0);
  return userChars >= MIN_DISTILL_USER_CHARS;
}
