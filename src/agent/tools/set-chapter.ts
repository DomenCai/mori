import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SetChapterParams } from "../schemas.js";
import type { MemoryService } from "../../memory/service.js";

export function createSetChapterTool(
  memoryService: MemoryService,
  getRunId?: () => string | undefined,
): AgentTool<typeof SetChapterParams> {
  return {
    name: "set_chapter",
    label: "更新当前主线",
    description:
      "整体重写当前主线。只在周度合并中使用，用来保存跨 storyline 的当前阶段、主题或反复卡点。",
    parameters: SetChapterParams,
    execute: async (_id, params) => {
      memoryService.setChapter(params, getRunId?.());
      return {
        content: [
          {
            type: "text",
            text: `已更新当前主线：${params.reason}`,
          },
        ],
        details: {
          source_storyline_ids: params.source_storyline_ids,
        },
      };
    },
  };
}
