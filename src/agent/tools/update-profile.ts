import type { AgentTool } from "@earendil-works/pi-agent-core";
import { UpdateProfileParams } from "../schemas.js";
import type { MemoryService } from "../../memory/service.js";

export function createUpdateProfileTool(
  memoryService: MemoryService,
  getRunId?: () => string | undefined,
): AgentTool<typeof UpdateProfileParams> {
  return {
    name: "update_profile",
    label: "更新身份画像",
    description:
      "修改身份画像。仅在周度合并或显式纠错时可用，日记轮禁止调用。操作：add/replace/remove。",
    parameters: UpdateProfileParams,
    execute: async (_id, params) => {
      memoryService.updateProfile(params, getRunId?.());
      return {
        content: [
          {
            type: "text",
            text: `📝 画像已${params.operation === "add" ? "添加" : params.operation === "replace" ? "替换" : "删除"}：${params.reason}`,
          },
        ],
        details: { operation: params.operation },
      };
    },
  };
}
