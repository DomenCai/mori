import type { AgentTool } from "@earendil-works/pi-agent-core";
import { UpsertWorkingItemParams } from "../schemas.js";
import type { MemoryService } from "../../memory/service.js";

export function createUpsertWorkingItemTool(
  memoryService: MemoryService,
): AgentTool<typeof UpsertWorkingItemParams> {
  return {
    name: "upsert_working_item",
    label: "更新工作集",
    description:
      "新增或更新工作集条目（project / open_loop）。日记轮和周合并均可调用。",
    parameters: UpsertWorkingItemParams,
    execute: async (_id, params) => {
      const itemId = memoryService.upsertWorkingItem(params);
      const verb = params.id ? "更新" : "新建";
      return {
        content: [
          {
            type: "text",
            text: `💾 已${verb}：${params.name} → ${params.status}`,
          },
        ],
        details: { id: itemId },
      };
    },
  };
}
