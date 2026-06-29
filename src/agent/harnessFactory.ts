import {
  AgentHarness,
  JsonlSessionRepo,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { LarkChannel } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { businessDateKey, genId, nowISO } from "../utils.js";
import { DEFAULT_PROFILE, type AgentChatType } from "../config.js";
import { DiaryService } from "../diary/service.js";
import { MemoryService } from "../memory/service.js";
import { MessageService } from "../storage/messages.js";
import { VaultService } from "../knowledge/vault.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { logger } from "../log.js";
import type { BaseAgent } from "./base.js";
import {
  absSessionPath,
  toRelativeSessionPath,
  SessionRegistry,
  type AgentSessionRow,
} from "./sessions.js";
import { installToolGuard } from "./toolGuard.js";
import { AgentRuntime, type HarnessEntry, type HarnessModelProfile } from "./runtime.js";
import { createToolCatalog, resolveActiveToolNames } from "./toolCatalog.js";

const log = logger("harness");

export interface CreateRuntimeOptions {
  agent: BaseAgent;
  runId?: string;
  activeToolNames?: string[];
  extraTools?: ReadonlyArray<AgentTool<any>>;
  profileName?: string;
  registerToRegistry: boolean;
  reopenRow?: AgentSessionRow;
}

export interface HarnessFactoryDeps {
  env: NodeExecutionEnv;
  repo: JsonlSessionRepo;
  sessionsDir: string;
  profiles: Record<string, HarnessModelProfile>;
  chatTypes: Partial<Record<AgentChatType, string>>;
  diaryService: DiaryService;
  memoryService: MemoryService;
  messageService: MessageService;
  vaultService: VaultService;
  sessionRegistry: SessionRegistry;
  db: Database.Database;
  channel?: LarkChannel;
  registry?: ChatRegistry;
}

export class HarnessFactory {
  constructor(private readonly deps: HarnessFactoryDeps) {}

  async create(scopeId: string, opts: CreateRuntimeOptions): Promise<AgentRuntime> {
    const deps = this.deps;
    const agent = opts.agent;
    const chatType = agent.chatType;
    const reopenRow = opts.reopenRow;
    const cwd = reopenRow
      ? reopenRow.cwd
      : `${chatType}/${businessDateKey().slice(0, 7)}`;

    let profileName =
      opts.profileName ??
      reopenRow?.profile_name ??
      deps.chatTypes[chatType] ??
      DEFAULT_PROFILE;
    let profile = deps.profiles[profileName];
    if (!profile) {
      const fallback = deps.chatTypes[chatType] ?? DEFAULT_PROFILE;
      log.warn(
        `恢复 session=${reopenRow?.id ?? "(new)"} 找不到 profile=${profileName}，降级为 ${fallback}`,
      );
      profileName = fallback;
      profile = deps.profiles[profileName];
      if (!profile) {
        throw new Error(`未找到模型档位: ${profileName}（chatType=${chatType}）`);
      }
    }

    const session = reopenRow
      ? await deps.repo.open({
          id: "",
          createdAt: "",
          cwd: reopenRow.cwd,
          path: absSessionPath(reopenRow.session_path, deps.sessionsDir),
        })
      : await deps.repo.create({ cwd });

    const metadata = await session.getMetadata();
    const relativePath = toRelativeSessionPath(metadata.path, deps.sessionsDir);

    let runtime!: AgentRuntime;
    const allTools = createToolCatalog(
      deps,
      agent,
      () => runtime,
      opts.extraTools,
    );
    const activeToolNames = resolveActiveToolNames({
      explicit: opts.activeToolNames,
      reopenRow,
      agent,
      allTools,
    });

    const harness = new AgentHarness({
      env: deps.env,
      session,
      model: profile.model,
      tools: allTools,
      activeToolNames,
      systemPrompt: agent.systemPrompt(),
      getApiKeyAndHeaders: async () => ({ apiKey: profile.apiKey }),
      streamOptions: profile.streamOptions,
    });

    let sessionRowId: string | null = null;
    let segmentStartedAt: string | null = null;
    let segmentEndedAt: string | null = null;
    if (opts.registerToRegistry) {
      if (reopenRow) {
        sessionRowId = reopenRow.id;
        segmentStartedAt = reopenRow.segment_started_at;
        segmentEndedAt = reopenRow.segment_ended_at;
        deps.sessionRegistry.touchActivity(reopenRow.id, nowISO());
      } else {
        const row = deps.sessionRegistry.create({
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

    const entry: HarnessEntry = {
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
      sessionPolicyKey: agent.sessionPolicyKey(),
      sessionRowId,
    };

    runtime = new AgentRuntime(entry);
    return runtime;
  }
}
