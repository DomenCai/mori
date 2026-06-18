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
    const session = await this.repo.create({ cwd: process.cwd() });

    const snapshot = buildMemorySnapshot(this.db);
    const systemPrompt = buildSystemPrompt(snapshot);
    const route =
      chatType === "consolidation" ? this.routes.weekly : this.routes.companion;

    const isDiaryRound = chatType === "diary";
    const isConsolidation = chatType === "consolidation";
    const canEditProfile = isConsolidation;

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
