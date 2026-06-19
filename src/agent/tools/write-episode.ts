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
      "把当前日记、反应或会话片段蒸馏成结构化 episode 并落库。不得修改身份画像。\n" +
      "observations 要主动覆盖这些维度（别只记表面事实）：客观事实(fact)、情绪及其触发(emotion)、" +
      "判断与立场(judgment)、兴趣与偏好(interest/preference)、自我盲点与回避(blind_spot)、" +
      "反复出现像稳定特质的信号(trait_signal)、未闭环的事(open_loop)。每条都要带原文 evidence。" +
      "正在推进的项目/行动写进工作集，不要塞进 observations。",
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
