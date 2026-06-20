import { Type, type Static } from "@earendil-works/pi-ai";

export const EpisodeParams = Type.Object({
  brief: Type.String({ description: "一句话概括这段内容" }),
  observations: Type.Array(
    Type.Object({
      text: Type.String({
        description: "关于用户的一条观察：事实、判断、立场、兴趣、偏好、情绪、决定或未闭环的事",
      }),
      evidence: Type.String({ description: "支撑这条观察的原文片段" }),
      tag: Type.Optional(
        Type.String({
          description:
            "可选标签，如 fact/emotion/judgment/interest/preference/decision/open_loop/trait_signal",
        }),
      ),
    }),
    { description: "带原文证据的用户上下文观察；一种形状吃所有来源（日记/反应/会话）" },
  ),
});
export type EpisodeData = Static<typeof EpisodeParams>;

export const StorylineKindParams = Type.Union([
  Type.Literal("project"),
  Type.Literal("relationship"),
  Type.Literal("emotional_arc"),
  Type.Literal("interest"),
  Type.Literal("identity_shift"),
  Type.Literal("open_loop"),
]);
export type StorylineKind = Static<typeof StorylineKindParams>;

export const StorylineStatusParams = Type.Union([
  Type.Literal("active"),
  Type.Literal("dormant"),
  Type.Literal("closed"),
]);
export type StorylineStatus = Static<typeof StorylineStatusParams>;

export const CreateStorylineParams = Type.Object({
  kind: StorylineKindParams,
  title: Type.String({ description: "稳定标题，不要写成当天日记标题" }),
  summary: Type.String({ description: "这条叙事线当前说明什么" }),
  current_tension: Type.Optional(Type.String({ description: "当前张力、悬念或开放问题" })),
  emotional_arc: Type.Optional(Type.String({ description: "态度或情绪如何连续变化" })),
  people: Type.Optional(Type.Array(Type.String())),
  source_episode_ids: Type.Array(Type.String(), { description: "支撑这次新建的 episode IDs" }),
  reason: Type.String({ description: "为什么需要新建而不是延续已有线" }),
});
export type CreateStorylineData = Static<typeof CreateStorylineParams>;

export const AdvanceStorylineParams = Type.Object({
  id: Type.String({ description: "要推进的 storyline ID，必须来自当前 snapshot 或工具返回" }),
  summary: Type.Optional(Type.String({ description: "增量压缩后的主线摘要" })),
  current_tension: Type.Optional(Type.String({ description: "新的当前张力或悬念" })),
  emotional_arc: Type.Optional(Type.String({ description: "新的连续情绪/态度变化" })),
  people: Type.Optional(Type.Array(Type.String())),
  source_episode_ids: Type.Array(Type.String(), { description: "支撑这次推进的 episode IDs" }),
  reason: Type.String({ description: "为什么这些证据推进了这条线" }),
});
export type AdvanceStorylineData = Static<typeof AdvanceStorylineParams>;

export const SetStorylineStatusParams = Type.Object({
  id: Type.String({ description: "要改状态的 storyline ID" }),
  status: StorylineStatusParams,
  source_episode_ids: Type.Optional(Type.Array(Type.String())),
  reason: Type.String({ description: "状态变化原因" }),
});
export type SetStorylineStatusData = Static<typeof SetStorylineStatusParams>;

export const MergeStorylinesParams = Type.Object({
  keep_id: Type.String({ description: "保留的 storyline ID" }),
  merge_ids: Type.Array(Type.String(), { description: "合并进 keep_id 的其它 storyline ID" }),
  summary: Type.String({ description: "合并后的压缩摘要" }),
  current_tension: Type.Optional(Type.String()),
  emotional_arc: Type.Optional(Type.String()),
  people: Type.Optional(Type.Array(Type.String())),
  source_episode_ids: Type.Array(Type.String()),
  reason: Type.String({ description: "为什么这些线重复或高度重叠" }),
});
export type MergeStorylinesData = Static<typeof MergeStorylinesParams>;

export const GetStorylineParams = Type.Object({
  id: Type.String({ description: "storyline ID" }),
});
export type GetStorylineData = Static<typeof GetStorylineParams>;

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

export const SearchMemoryParams = Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  limit: Type.Optional(
    Type.Number({ description: "最多返回条数", default: 10 }),
  ),
});
export type SearchMemoryData = Static<typeof SearchMemoryParams>;

export const SendCheckinParams = Type.Object({
  text: Type.String({ description: "最终发送给日记群的短文本" }),
});
export type SendCheckinData = Static<typeof SendCheckinParams>;

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
