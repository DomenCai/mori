import { Type, type Static } from "@earendil-works/pi-ai";

export const EpisodeParams = Type.Object({
  brief: Type.String({ description: "一句话概括这篇日记" }),
  facts: Type.Array(
    Type.Object({
      text: Type.String(),
      evidence: Type.String(),
    }),
    { description: "客观事实" },
  ),
  emotions: Type.Array(
    Type.Object({
      emotion: Type.String(),
      intensity: Type.Number({ minimum: 1, maximum: 5 }),
      trigger: Type.String(),
      evidence: Type.String(),
    }),
    { description: "情绪" },
  ),
  thoughts: Type.Array(
    Type.Object({
      text: Type.String(),
      type: Type.String(),
      confidence: Type.String(),
      evidence: Type.String(),
    }),
    { description: "想法与思考" },
  ),
  blind_spots: Type.Array(
    Type.Object({
      text: Type.String(),
      severity: Type.String(),
      friend_comment: Type.String(),
      evidence: Type.String(),
    }),
    { description: "盲点" },
  ),
  actions: Type.Array(
    Type.Object({
      text: Type.String(),
      priority: Type.String(),
      due_hint: Type.String(),
      why_it_matters: Type.String(),
    }),
    { description: "行动建议" },
  ),
  long_term_memory_candidates: Type.Array(
    Type.Object({
      type: Type.String(),
      content: Type.String(),
      confidence: Type.String(),
      reason: Type.String(),
    }),
    { description: "长期记忆候选" },
  ),
});
export type EpisodeData = Static<typeof EpisodeParams>;

export const UpsertWorkingItemParams = Type.Object({
  id: Type.Optional(Type.String({ description: "已有条目 ID（新建时省略）" })),
  type: Type.Union([Type.Literal("project"), Type.Literal("open_loop")]),
  name: Type.String(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("dormant"),
    Type.Literal("done"),
    Type.Literal("dropped"),
  ]),
  thesis: Type.Optional(Type.String()),
  current_questions: Type.Optional(Type.Array(Type.String())),
  decisions: Type.Optional(Type.Array(Type.String())),
  next_steps: Type.Optional(Type.Array(Type.String())),
  related_people: Type.Optional(Type.Array(Type.String())),
});
export type UpsertWorkingItemData = Static<typeof UpsertWorkingItemParams>;

export const UpdateProfileParams = Type.Object({
  operation: Type.Union([
    Type.Literal("add"),
    Type.Literal("replace"),
    Type.Literal("remove"),
  ]),
  old_text: Type.Optional(
    Type.String({ description: "要替换/删除的唯一子串" }),
  ),
  new_text: Type.Optional(Type.String({ description: "新内容" })),
  reason: Type.String({ description: "变更原因" }),
  source_episode_ids: Type.Optional(Type.Array(Type.String())),
  source_diary_ids: Type.Optional(Type.Array(Type.String())),
});
export type UpdateProfileData = Static<typeof UpdateProfileParams>;

export const SearchDiaryParams = Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  limit: Type.Optional(
    Type.Number({ description: "最多返回条数", default: 10 }),
  ),
});
export type SearchDiaryData = Static<typeof SearchDiaryParams>;
