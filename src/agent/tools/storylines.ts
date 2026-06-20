import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  AdvanceStorylineParams,
  CreateStorylineParams,
  GetStorylineParams,
  MergeStorylinesParams,
  SetStorylineStatusParams,
} from "../schemas.js";
import type { MemoryService } from "../../memory/service.js";

export function createCreateStorylineTool(
  memoryService: MemoryService,
  getRunId?: () => string | undefined,
): AgentTool<typeof CreateStorylineParams> {
  return {
    name: "create_storyline",
    label: "新建 Storyline",
    description:
      "新建叙事线。只能在确实无法归入已有 active/recent dormant 线时使用；新建后默认为 active。",
    parameters: CreateStorylineParams,
    execute: async (_id, params) => {
      const storylineId = memoryService.createStoryline(params, getRunId?.());
      return {
        content: [
          {
            type: "text",
            text: `已新建 storyline：${params.title}`,
          },
        ],
        details: { id: storylineId, operation: "created" },
      };
    },
  };
}

export function createAdvanceStorylineTool(
  memoryService: MemoryService,
  getRunId?: () => string | undefined,
): AgentTool<typeof AdvanceStorylineParams> {
  return {
    name: "advance_storyline",
    label: "推进 Storyline",
    description:
      "推进已有叙事线。参数层不允许修改 title/kind；若 dormant 线被推进，会重新变为 active。",
    parameters: AdvanceStorylineParams,
    execute: async (_id, params) => {
      const storylineId = memoryService.advanceStoryline(params, getRunId?.());
      return {
        content: [
          {
            type: "text",
            text: `已推进 storyline：${storylineId}`,
          },
        ],
        details: { id: storylineId, operation: "advanced" },
      };
    },
  };
}

export function createSetStorylineStatusTool(
  memoryService: MemoryService,
  getRunId?: () => string | undefined,
): AgentTool<typeof SetStorylineStatusParams> {
  return {
    name: "set_storyline_status",
    label: "设置 Storyline 状态",
    description:
      "只修改 storyline 状态：active、dormant 或 closed。不要用它重写标题、类型或摘要。",
    parameters: SetStorylineStatusParams,
    execute: async (_id, params) => {
      if (params.status === "active") {
        throw new Error("唤醒 dormant/closed storyline 必须使用 advance_storyline，并带 source_episode_ids");
      }
      const storylineId = memoryService.setStorylineStatus(params, getRunId?.());
      return {
        content: [
          {
            type: "text",
            text: `已设置 storyline 状态：${storylineId} → ${params.status}`,
          },
        ],
        details: { id: storylineId, operation: "set_status" },
      };
    },
  };
}

export function createMergeStorylinesTool(
  memoryService: MemoryService,
  getRunId?: () => string | undefined,
): AgentTool<typeof MergeStorylinesParams> {
  return {
    name: "merge_storylines",
    label: "合并 Storylines",
    description:
      "合并重复或高度重叠的叙事线。保留 keep_id，merge_ids 会软关闭为 closed。",
    parameters: MergeStorylinesParams,
    execute: async (_id, params) => {
      const storylineId = memoryService.mergeStorylines(params, getRunId?.());
      return {
        content: [
          {
            type: "text",
            text: `已合并 storylines：保留 ${storylineId}`,
          },
        ],
        details: { id: storylineId, operation: "merged" },
      };
    },
  };
}

export function createGetStorylineTool(
  memoryService: MemoryService,
): AgentTool<typeof GetStorylineParams> {
  return {
    name: "get_storyline",
    label: "查看 Storyline",
    description: "按 ID 读取单条 storyline 的完整结构和最近 revisions。",
    parameters: GetStorylineParams,
    execute: async (_id, params) => {
      const storyline = memoryService.getStoryline(params.id);
      if (!storyline) {
        return {
          content: [{ type: "text", text: `storyline 不存在：${params.id}` }],
          details: { found: false },
        };
      }
      const revisions = memoryService.getStorylineRevisions(params.id).slice(0, 5);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ storyline, revisions }, null, 2),
          },
        ],
        details: { found: true, id: params.id },
      };
    },
  };
}
