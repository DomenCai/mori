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

export const WorkingItemFields = {
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
};

export const CreateWorkingItemParams = Type.Object(WorkingItemFields);
export type CreateWorkingItemData = Static<typeof CreateWorkingItemParams>;

export const UpdateWorkingItemParams = Type.Object({
  id: Type.String({ description: "要更新的工作集 ID，必须来自当前工作集 snapshot 或工具返回" }),
  ...WorkingItemFields,
});
export type UpdateWorkingItemData = Static<typeof UpdateWorkingItemParams>;

export const MergeWorkingItemsParams = Type.Object({
  keep_id: Type.String({ description: "保留的工作集 ID" }),
  merge_ids: Type.Array(Type.String(), { description: "合并进 keep_id 的其它工作集 ID" }),
  name: Type.String(),
  type: Type.Union([Type.Literal("project"), Type.Literal("open_loop")]),
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
  merged_item_status: Type.Optional(
    Type.Union([Type.Literal("dropped"), Type.Literal("dormant")]),
  ),
});
export type MergeWorkingItemsData = Static<typeof MergeWorkingItemsParams>;

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
});
export type UpdateProfileData = Static<typeof UpdateProfileParams>;

export const SearchDiaryParams = Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  limit: Type.Optional(
    Type.Number({ description: "最多返回条数", default: 10 }),
  ),
});
export type SearchDiaryData = Static<typeof SearchDiaryParams>;

export const FetchArticleParams = Type.Object({
  url: Type.String({ description: "要抓取并清洗成 markdown 的 URL" }),
});
export type FetchArticleData = Static<typeof FetchArticleParams>;

export const SaveToGardenParams = Type.Object({
  title: Type.String(),
  domain: Type.String(),
  brief: Type.String(),
  body: Type.String({ description: "markdown 正文，创建后 Agent 不再编辑" }),
  tags: Type.Optional(Type.Array(Type.String())),
  source_url: Type.Optional(Type.String()),
});
export type SaveToGardenData = Static<typeof SaveToGardenParams>;

export const GrepVaultParams = Type.Object({
  query: Type.String(),
  scope: Type.Optional(Type.String({ description: "vault 相对路径，可省略" })),
});
export type GrepVaultData = Static<typeof GrepVaultParams>;

export const ReadVaultParams = Type.Object({
  path: Type.String({ description: "vault 相对路径" }),
});
export type ReadVaultData = Static<typeof ReadVaultParams>;

export const UpdateFrontmatterParams = Type.Object({
  path: Type.String({ description: "vault 相对路径" }),
  frontmatter_json: Type.String({
    description: "要覆盖进 frontmatter 的 JSON 对象字符串；不会修改正文",
  }),
});
export type UpdateFrontmatterData = Static<typeof UpdateFrontmatterParams>;

export const PromoteParams = Type.Object({
  path: Type.String({ description: "Inbox 文件的 vault 相对路径" }),
  my_note: Type.Optional(Type.String({ description: "用户为什么收藏/怎么看" })),
});
export type PromoteData = Static<typeof PromoteParams>;
