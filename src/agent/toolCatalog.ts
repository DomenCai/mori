import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LarkChannel } from "@larksuite/channel";
import type Database from "better-sqlite3";
import { DiaryService } from "../diary/service.js";
import { MemoryService } from "../memory/service.js";
import { MessageService } from "../storage/messages.js";
import { VaultService } from "../knowledge/vault.js";
import type { ChatRegistry } from "../lark/chatRegistry.js";
import { logger } from "../log.js";
import type { BaseAgent } from "./base.js";
import type { AgentRuntime } from "./runtime.js";
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
import type { AgentSessionRow } from "./sessions.js";

const log = logger("harness");

export interface ToolCatalogDeps {
  diaryService: DiaryService;
  memoryService: MemoryService;
  messageService: MessageService;
  vaultService: VaultService;
  db: Database.Database;
  channel?: LarkChannel;
  registry?: ChatRegistry;
}

export function createToolCatalog(
  deps: ToolCatalogDeps,
  agent: BaseAgent,
  runtime: () => AgentRuntime,
  extraTools: ReadonlyArray<AgentTool<any>> = [],
): AgentTool[] {
  const tools: AgentTool[] = [
    createWriteEpisodeTool(
      deps.diaryService,
      () => runtime().currentEpisodeSource,
    ),
    createGetStorylineTool(deps.memoryService),
    createCreateStorylineTool(deps.memoryService, () => runtime().runId),
    createAdvanceStorylineTool(deps.memoryService, () => runtime().runId),
    createSetStorylineStatusTool(deps.memoryService, () => runtime().runId),
    createMergeStorylinesTool(deps.memoryService, () => runtime().runId),
    createSearchMemoryTool(deps.db),
    ...createKnowledgeTools(deps.vaultService),
  ];

  if (deps.channel && deps.registry) {
    tools.push(
      createSendCheckinTool(deps.channel, deps.registry, deps.messageService),
    );
  }

  if (agent.toolGroups.includes("profile_edit")) {
    tools.push(createUpdateProfileTool(deps.memoryService, () => runtime().runId));
    tools.push(createSetChapterTool(deps.memoryService, () => runtime().runId));
  }

  for (const tool of extraTools) {
    if (tools.some((existing) => existing.name === tool.name)) {
      throw new Error(`自定义工具名与内置工具冲突：${tool.name}`);
    }
    tools.push(tool);
  }

  return tools;
}

export function resolveActiveToolNames(opts: {
  explicit?: string[];
  reopenRow?: AgentSessionRow;
  agent: BaseAgent;
  allTools: AgentTool[];
}): string[] {
  const allNames = new Set(opts.allTools.map((tool) => tool.name));

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
      if (Array.isArray(stored) && stored.every((value) => typeof value === "string")) {
        const filtered: string[] = [];
        for (const name of stored) {
          if (allNames.has(name)) filtered.push(name);
          else log.warn(`恢复 session=${opts.reopenRow.id} 工具 ${name} 已不存在，丢弃`);
        }
        if (filtered.length > 0) return filtered;
        log.warn(`恢复 session=${opts.reopenRow.id} 工具集过滤后为空，降级为当前默认`);
      } else {
        log.warn(`恢复 session=${opts.reopenRow.id} active_tool_names_json 不是字符串数组，降级`);
      }
    } catch (err) {
      log.warn(`恢复 session=${opts.reopenRow.id} active_tool_names_json 解析失败，降级`, err);
    }
  }

  const defaultNames = [...opts.agent.defaultTools];
  const unknown = defaultNames.filter((name) => !allNames.has(name));
  if (unknown.length > 0) {
    throw new Error(`未知工具：${unknown.join(", ")}`);
  }
  return defaultNames;
}
