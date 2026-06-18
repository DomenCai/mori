import type { AgentTool } from "@earendil-works/pi-agent-core";
import { EpisodeParams } from "../schemas.js";
import type { DiaryService } from "../../diary/service.js";

export function createWriteEpisodeTool(
  diaryService: DiaryService,
  getCurrentDiaryEntryId: () => string | null,
): AgentTool<typeof EpisodeParams> {
  return {
    name: "write_episode",
    label: "写 Episode",
    description:
      "读完一篇日记后，把它蒸馏成结构化 episode 并落库。每篇日记必须调用一次。",
    parameters: EpisodeParams,
    execute: async (_id, params) => {
      const entryId = getCurrentDiaryEntryId();
      if (!entryId) {
        throw new Error("当前没有关联的日记条目");
      }
      const id = diaryService.saveEpisode(entryId, params);
      return {
        content: [{ type: "text", text: `episode ${id} 已保存` }],
        details: { id, diaryEntryId: entryId },
      };
    },
  };
}
