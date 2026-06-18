import {
  AgentHarness,
  JsonlSessionRepo,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import type Database from "better-sqlite3";
import { DiaryService } from "../diary/service.js";
import { MemoryService } from "../memory/service.js";
import { buildMemorySnapshot, buildSystemPrompt } from "./prompts.js";
import { createWriteEpisodeTool } from "./tools/write-episode.js";
import { createUpsertWorkingItemTool } from "./tools/upsert-working-item.js";
import { createUpdateProfileTool } from "./tools/update-profile.js";
import { createSearchDiaryTool } from "./tools/search-diary.js";
import { shanghaiFileTimestamp } from "../utils.js";

const SESSION_CWD = "personal-agent";

export interface HarnessEntry {
  harness: AgentHarness;
  scopeId: string;
  chatType: "diary" | "dm" | "topic" | "consolidation";
  routeName: "companion" | "weekly";
  modelId: string;
  runId?: string;
  lastActivityAt: number;
  currentDiaryEntryId: string | null;
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
  private db: Database.Database;
  private routes: HarnessManagerOptions["routes"];

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
  }

  getDiaryService(): DiaryService {
    return this.diaryService;
  }

  getMemoryService(): MemoryService {
    return this.memoryService;
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

  private async createEntry(
    scopeId: string,
    chatType: HarnessEntry["chatType"],
    opts: { runId?: string },
  ): Promise<HarnessEntry> {
    const session = await this.repo.create({ cwd: SESSION_CWD });

    const route =
      chatType === "consolidation" ? this.routes.weekly : this.routes.companion;

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
      createWriteEpisodeTool(
        this.diaryService,
        () => entry.currentDiaryEntryId,
      ),
      createUpsertWorkingItemTool(this.memoryService),
      createSearchDiaryTool(this.db),
    ];

    if (canEditProfile) {
      allTools.push(createUpdateProfileTool(this.memoryService, () => entry.runId));
    }

    const activeToolNames = isDiaryRound
      ? ["write_episode", "upsert_working_item", "search_diary"]
      : isConsolidation
        ? ["upsert_working_item", "update_profile", "search_diary"]
        : ["search_diary", "upsert_working_item"];

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

    // 日记轮拦截：禁止调用 update_profile
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
      currentDiaryEntryId: null,
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

  async resetSession(scopeId: string): Promise<void> {
    this.entries.delete(scopeId);
  }

  cleanupIdle(timeoutMs: number): void {
    const now = Date.now();
    for (const [scopeId, entry] of this.entries) {
      if (entry.chatType === "topic") continue;
      if (now - entry.lastActivityAt > timeoutMs) {
        this.entries.delete(scopeId);
      }
    }
  }
}

function appendSessionInstructions(
  basePrompt: string,
  chatType: HarnessEntry["chatType"],
): string {
  if (chatType !== "diary") return basePrompt;

  return `${basePrompt}

---
# 当前会话：日记群
- 用户消息会带有场景标记：
  - [日记群新日记]：这是一条新的日记根消息，必须先调用 write_episode 工具把原文蒸馏成 episode。
  - [日记群追问]：这是用户在同一篇日记上下文里继续回复，不是新的日记；不要求调用 write_episode。
- 如果内容涉及正在推进的项目、开放问题或明确决策，再调用 upsert_working_item。
- 对 [日记群新日记]，在完成必要工具调用前不要输出面向用户的回复文本；工具完成后再简短回应。
- 对 [日记群追问]，可以直接自然回复；需要检索或更新工作集时再调用工具。`;
}
