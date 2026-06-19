import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  CreateWorkingItemParams,
  MergeWorkingItemsParams,
  type UpdateWorkingItemData,
  UpdateWorkingItemParams,
} from "../schemas.js";
import type { MemoryService } from "../../memory/service.js";
import type { ApprovalService } from "../../memory/approvals.js";

export function createCreateWorkingItemTool(
  memoryService: MemoryService,
): AgentTool<typeof CreateWorkingItemParams> {
  return {
    name: "create_working_item",
    label: "新建工作集",
    description:
      "新建一个工作集条目。不能覆盖已有条目；若同 type、同标准化 name 的 active/dormant 条目已存在会失败并返回候选 ID。",
    parameters: CreateWorkingItemParams,
    execute: async (_id, params) => {
      const itemId = memoryService.createWorkingItem(params);
      return {
        content: [
          {
            type: "text",
            text: `💾 已新建工作集：${params.name} → ${params.status}`,
          },
        ],
        details: { id: itemId, operation: "created" },
      };
    },
  };
}

export function createUpdateWorkingItemTool(
  memoryService: MemoryService,
  opts: {
    approvalService?: ApprovalService;
    planUpdate?: (params: UpdateWorkingItemData) => number;
    requireApproval?: (params: UpdateWorkingItemData) => string | null;
    getChatId?: () => string | null;
    getRunId?: () => string | undefined;
  } = {},
): AgentTool<typeof UpdateWorkingItemParams> {
  return {
    name: "update_working_item",
    label: "更新工作集",
    description:
      "更新已有工作集。id 必填，找不到时会失败；不会隐式新建。",
    parameters: UpdateWorkingItemParams,
    execute: async (_id, params) => {
      const plannedIndex = opts.planUpdate?.(params);
      if (plannedIndex !== undefined) {
        return {
          content: [
            {
              type: "text",
              text: `📝 已计划工作集更新 #${plannedIndex}：${params.name} → ${params.status}`,
            },
          ],
          details: {
            operation: "planned",
            plannedIndex,
            id: params.id,
          },
        };
      }

      const approvalReason = opts.requireApproval?.(params);
      if (opts.approvalService && approvalReason) {
        const approvalId = opts.approvalService.createPending({
          toolName: "update_working_item",
          payload: {
            tool_name: "update_working_item",
            data: params,
            reason: approvalReason,
          },
          chatId: opts.getChatId?.() ?? null,
          runId: opts.getRunId?.(),
        });
        return {
          content: [
            {
              type: "text",
              text: `⏳ 工作集更新需审批：${params.name} → ${params.status}`,
            },
          ],
          details: { approvalId, approvalRequired: true },
        };
      }

      const itemId = memoryService.updateWorkingItem(params);
      return {
        content: [
          {
            type: "text",
            text: `💾 已更新工作集：${params.name} → ${params.status}`,
          },
        ],
        details: { id: itemId, operation: "updated" },
      };
    },
  };
}

export function createMergeWorkingItemsTool(
  approvalService: ApprovalService,
  opts: {
    getChatId?: () => string | null;
    getRunId?: () => string | undefined;
  } = {},
): AgentTool<typeof MergeWorkingItemsParams> {
  return {
    name: "merge_working_items",
    label: "合并工作集",
    description:
      "提出工作集合并方案。该工具只创建待审批记录，不直接落库；审批通过后由确定性 executor 执行。",
    parameters: MergeWorkingItemsParams,
    execute: async (_id, params) => {
      const approvalId = approvalService.createPending({
        toolName: "merge_working_items",
        payload: {
          tool_name: "merge_working_items",
          data: params,
          reason: `合并 ${params.merge_ids.length} 个工作集到 ${params.keep_id}`,
        },
        chatId: opts.getChatId?.() ?? null,
        runId: opts.getRunId?.(),
      });
      return {
        content: [
          {
            type: "text",
            text: `⏳ 工作集合并需审批：保留 ${params.keep_id}，合并 ${params.merge_ids.join(", ")}`,
          },
        ],
        details: { approvalId, approvalRequired: true },
      };
    },
  };
}
