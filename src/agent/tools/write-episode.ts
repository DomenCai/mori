import type { AgentTool } from "@earendil-works/pi-agent-core";
import { EpisodeParams } from "../schemas.js";
import type { DiaryService, EpisodeSource } from "../../diary/service.js";

export function createWriteEpisodeTool(
  diaryService: DiaryService,
  getCurrentEpisodeSource: () => EpisodeSource | null,
): AgentTool<typeof EpisodeParams> {
  return {
    name: "write_episode",
    label: "写 Episode",
    description:
      "把当前日记、反应或会话片段蒸馏成结构化 episode 并落库。不得修改身份画像。",
    parameters: EpisodeParams,
    execute: async (_id, params) => {
      const source = getCurrentEpisodeSource();
      if (!source) {
        throw new Error("当前没有关联的 episode 来源");
      }
      const id = diaryService.saveEpisode(source, params);
      return {
        content: [{ type: "text", text: `episode ${id} 已保存` }],
        details: { id, source },
      };
    },
  };
}
