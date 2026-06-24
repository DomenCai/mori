import { businessDateKey, textLineChanges } from "../utils.js";
import type {
  ChapterRevision,
  DailyMemoryRun,
  ProfileRevision,
  Storyline,
  StorylineRevision,
} from "../memory/service.js";

export type AgentToolStatus = "running" | "done" | "error";

export interface AgentTextBlock {
  type: "text";
  content: string;
}

export interface AgentToolBlock {
  type: "tool";
  id: string;
  name: string;
  args: unknown;
  status: AgentToolStatus;
  output?: string;
}

export type AgentCardBlock = AgentTextBlock | AgentToolBlock;

export interface AgentCardMetrics {
  totalTokens: number;
  contextWindow: number;
  elapsedMs: number;
}

export interface AgentCardState {
  blocks: AgentCardBlock[];
  footer: "thinking" | "tool_running" | "streaming" | null;
  terminal: "running" | "done" | "error";
  status?: string;
  metrics?: AgentCardMetrics;
}

export function renderMarkdownCard(content: string): object {
  return {
    schema: "2.0",
    body: {
      elements: [{ tag: "markdown", content }],
    },
  };
}

// 定时知识投递卡：标题 + 正文，底部一道横线 + 小字回复提示。
const KNOWLEDGE_CARD_HINT =
  "普通回复这张卡会收藏并记录你的看法；话题回复会进入临时深聊。";

export function renderKnowledgeCard(title: string, content: string): object {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title } },
    body: {
      elements: [markdown(content), { tag: "hr" }, note(KNOWLEDGE_CARD_HINT)],
    },
  };
}

// 斜杠命令的展示卡片：带蓝色标题栏 + 一段 markdown 正文。
export function renderInfoCard(title: string, body: string): object {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    body: { elements: [markdown(body)] },
  };
}

export function renderStorylinesCard(items: Storyline[]): object {
  const active = items.filter((item) => item.status === "active").length;
  const dormant = items.filter((item) => item.status === "dormant").length;
  const elements: object[] = [
    note(`active: ${active} · dormant: ${dormant} · total: ${items.length}`),
    ...items.map((item) =>
      collapsiblePanel(storylineHeader(item), storylineBody(item, true)),
    ),
  ];

  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "📋 Storylines" }, template: "blue" },
    config: { summary: { content: `Storylines（${items.length}）` } },
    body: { elements },
  };
}

export function renderStorylineCard(
  item: Storyline,
  revisions: StorylineRevision[],
): object {
  const elements: object[] = [
    collapsiblePanel(storylineHeader(item), storylineBody(item), { expanded: true }),
  ];

  if (revisions.length > 0) {
    elements.push(
      collapsiblePanel(
        `🧾 修订记录（${revisions.length}）`,
        revisions
          .map((r) => `- **${dateFormat(r.created_at)}** · ${r.operation} · ${r.reason}`)
          .join("\n"),
      ),
    );
  }

  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "📋 Storyline" }, template: "blue" },
    config: { summary: { content: item.title } },
    body: { elements },
  };
}

export function renderDailyMemoryRunsCard(
  runs: DailyMemoryRun[],
  options: { expanded?: boolean; expandedIndex?: number } = {},
): object {
  const elements = runs.map((run, index) =>
    collapsiblePanel(dailyRunHeader(run), dailyRunBody(run), {
      expanded: options.expanded ?? index === options.expandedIndex,
    }),
  );

  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🌙 Daily Memory" }, template: "blue" },
    config: { summary: { content: `Daily Memory（${runs.length}）` } },
    body: { elements },
  };
}

export function renderChapterHistoryCard(revisions: ChapterRevision[]): object {
  const elements: object[] = revisions.length
    ? revisions.map((revision, index) =>
      collapsiblePanel(
        chapterRevisionHeader(revision),
        chapterRevisionBody(revision),
        { expanded: index === 0 },
      ),
    )
    : [markdown("暂无当前主线变更历史")];

  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🧭 当前主线历史" }, template: "blue" },
    config: { summary: { content: `当前主线历史（${revisions.length}）` } },
    body: { elements },
  };
}

// 画像变更历史卡：列表只露出行级变化摘要，展开后看原因和证据锚点。
export function renderProfileHistoryCard(
  rows: ProfileRevision[],
): object {
  const elements: object[] = rows.length
    ? rows.map((r, index) =>
      collapsiblePanel(
        profileRevisionHeader(r),
        profileRevisionBody(r),
        { expanded: index === 0 },
      ),
    )
    : [markdown("暂无画像变更历史")];
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "📋 身份画像历史" }, template: "blue" },
    config: { summary: { content: `身份画像历史（${rows.length}）` } },
    body: { elements },
  };
}

export function renderThinkingCard(): object {
  return renderMarkdownCard("思考中…");
}

export interface WeeklyRecordCardData {
  weekKey: string;
  recap: string;
  profileChanges: Array<{ reason: string; delta: string }>;
  storylineChanges: Array<{
    title: string;
    operation: string;
    status: string;
    reason: string;
  }>;
}

// 卡片 1「这周」：客观记录。做了什么 + 叙事线索变化 + 画像变更（折叠，默认收起）。
export function renderWeeklyRecordCard(data: WeeklyRecordCardData): object {
  const elements: object[] = [
    markdown(`**📊 这周（${data.weekKey}）**`),
    markdown(data.recap.trim() || "本周没有可记录的事实梳理。"),
  ];

  if (data.storylineChanges.length > 0) {
    const lines = data.storylineChanges
      .map((c) => `- ${c.operation} ${c.title} → ${c.status}（${c.reason}）`)
      .join("\n");
    elements.push(markdown(`**📌 叙事线索变化（${data.storylineChanges.length}）**\n${lines}`));
  }

  if (data.profileChanges.length > 0) {
    const body = data.profileChanges
      .map((c) => `- ${c.reason}\n  ${c.delta}`)
      .join("\n");
    elements.push(
      collapsiblePanel(`🧠 画像变更（${data.profileChanges.length}）`, body),
    );
    elements.push(note("不准确就用 /profile 查看或纠正"));
  }

  return {
    schema: "2.0",
    config: { summary: { content: `这周记录（${data.weekKey}）` } },
    body: { elements },
  };
}

// 卡片 2「朋友的话」：纯散文，没有标题/bullet，就是朋友看完你这周后说的话。
export function renderWeeklyFriendCard(message: string): object {
  return {
    schema: "2.0",
    config: { summary: { content: "朋友的话" } },
    body: { elements: [markdown(message.trim() || "……")] },
  };
}

function collapsiblePanel(
  title: string,
  body: string,
  options: { expanded?: boolean } = {},
): object {
  return {
    tag: "collapsible_panel",
    expanded: options.expanded ?? false,
    header: {
      title: { tag: "markdown", content: `**${title}**` },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px",
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: body, text_size: "notation" }],
  };
}

function storylineHeader(item: Storyline): string {
  return `${storylineStatusIcon(item.status)} ${item.title} · ${item.kind}`;
}

function storylineBody(item: Storyline, showId: boolean = false): string {
  const lines = [
    showId ? `**ID**: ${item.id}\n` : "",
    item.summary,
    item.current_tension ? `\n**当前张力**\n${item.current_tension}` : "",
    item.emotional_arc ? `\n**情绪/态度弧线**\n${item.emotional_arc}` : "",
    item.people.length ? `\n**相关人**\n${item.people.join("、")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function storylineStatusIcon(status: Storyline["status"]): string {
  if (status === "active") return "🟢";
  if (status === "dormant") return "💤";
  return "✅";
}

function dailyRunHeader(run: DailyMemoryRun): string {
  const nudge = run.nudge_sent ? "nudge sent" : run.nudge_evaluated ? "nudge evaluated" : "no nudge";
  return `${dailyRunStatusIcon(run.status)} ${run.date_key} · ${run.input_episode_ids.length} episodes · ${run.storyline_changes.length} changes · ${nudge}`;
}

function dailyRunBody(run: DailyMemoryRun): string {
  const lines = [
    run.dream_summary ? run.dream_summary : "",
    run.nudge_text ? `\n**nudge**\n${run.nudge_text}` : "",
    run.error ? `\n**error**\n${run.error}` : "",
    run.storyline_changes.length
      ? `\n**storyline changes**\n${run.storyline_changes
        .map((c) => `- ${c.operation} ${c.title} → ${c.status}（${c.reason}）`)
        .join("\n")}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function dailyRunStatusIcon(status: string): string {
  if (status === "completed") return "✅";
  if (status === "failed") return "❌";
  if (status === "running") return "⏳";
  return "🌙";
}

function chapterRevisionBody(revision: ChapterRevision): string {
  const changes = textLineChanges(revision.old_content ?? "", revision.new_content);
  const lines = [truncate(revision.reason, 1200)];
  if (revision.source_storyline_ids.length > 0) {
    lines.push(`\n**source storylines**\n${revision.source_storyline_ids.join("\n")}`);
  }
  if (changes.removed.length > 0) {
    lines.push(`\n**删除的行**\n${changes.removed.join("\n")}`);
  }
  if (changes.added.length > 0) {
    lines.push(`\n**新增的行**\n${changes.added.join("\n")}`);
  }
  return lines.filter(Boolean).join("\n\n");
}

function chapterRevisionHeader(revision: ChapterRevision): string {
  const changes = textLineChanges(revision.old_content ?? "", revision.new_content);
  return `🧭 ${dateFormat(revision.created_at)} · +${changes.added.length}/-${changes.removed.length}`;
}

function profileRevisionHeader(revision: ProfileRevision): string {
  const changes = textLineChanges(revision.old_content ?? "", revision.new_content);
  return `🧠 ${dateFormat(revision.created_at)} · +${changes.added.length}/-${changes.removed.length}`;
}

function profileRevisionBody(revision: ProfileRevision): string {
  const changes = textLineChanges(revision.old_content ?? "", revision.new_content);
  const lines = [truncate(revision.reason, 1200)];
  if (changes.removed.length > 0) {
    lines.push(`\n**删除的行**\n${changes.removed.join("\n")}`);
  }
  if (changes.added.length > 0) {
    lines.push(`\n**新增的行**\n${changes.added.join("\n")}`);
  }
  return lines.filter(Boolean).join("\n\n");
}

export function createAgentCardState(): AgentCardState {
  return {
    blocks: [],
    footer: "thinking",
    terminal: "running",
  };
}

export function renderAgentCard(state: AgentCardState): object {
  const elements: object[] = [];

  for (const block of state.blocks) {
    if (block.type === "text") {
      const content = block.content.trim();
      if (content) elements.push(markdown(content));
    } else {
      elements.push(toolPanel(block));
    }
  }

  if (state.status) {
    elements.push(note(state.status));
  }

  if (state.terminal !== "running" && state.metrics) {
    elements.push(note(metricsText(state.metrics)));
  }

  if (state.terminal === "running" && state.footer) {
    elements.push(note(footerText(state.footer)));
  }

  if (elements.length === 0) {
    elements.push(note(state.terminal === "running" ? "思考中…" : "（已处理）"));
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: state.terminal === "running",
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

export function renderToolCard(toolName: string, status: "running" | "done"): object {
  const label: Record<string, string> = {
    write_episode: "写 Episode",
    get_storyline: "查看 Storyline",
    create_storyline: "新建 Storyline",
    advance_storyline: "推进 Storyline",
    set_storyline_status: "设置 Storyline 状态",
    merge_storylines: "合并 Storyline",
    update_profile: "更新画像",
    set_chapter: "更新当前主线",
    search_memory: "搜索记忆",
    send_checkin: "发送轻触达",
    web_search: "搜索网页",
    fetch_article: "抓取文章",
    save_to_garden: "保存知识",
    grep_vault: "检索 Vault",
    read_vault: "读取 Vault",
    update_frontmatter: "更新 Frontmatter",
    promote: "晋升知识",
  };
  const icon = status === "running" ? "⏳" : "✅";
  return renderMarkdownCard(`${icon} ${label[toolName] ?? toolName}`);
}

function toolPanel(tool: AgentToolBlock): object {
  const border = tool.status === "error" ? "red" : "grey";
  return {
    tag: "collapsible_panel",
    expanded: tool.status === "running",
    header: {
      title: { tag: "markdown", content: toolHeader(tool) },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px",
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: border, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [
      {
        tag: "markdown",
        content: toolBody(tool),
        text_size: "notation",
      },
    ],
  };
}

function toolHeader(tool: AgentToolBlock): string {
  const icon =
    tool.status === "done" ? "✅" : tool.status === "error" ? "❌" : "⏳";
  const summary = summarizeArgs(tool.name, tool.args);
  const name = toolLabel(tool.name);
  return summary ? `${icon} **${name}** — ${summary}` : `${icon} **${name}**`;
}

function toolBody(tool: AgentToolBlock): string {
  const parts: string[] = [];
  const input = renderArgs(tool.name, tool.args);
  if (input) parts.push(input);

  if (tool.status === "running") {
    parts.push("_运行中…_");
  } else if (tool.output && tool.status === "error") {
    parts.push(`**Error**\n\`\`\`\n${truncate(tool.output, 1200)}\n\`\`\``);
  } else if (tool.output && shouldShowToolOutput(tool.name)) {
    parts.push(`**Output**\n\`\`\`\n${truncate(stripToolDetails(tool.output), 1600)}\n\`\`\``);
  }

  return parts.join("\n\n") || "_已完成_";
}

const TOOLS_WITH_VISIBLE_OUTPUT = new Set([
  "search_memory",
  "get_storyline",
  "web_search",
  "fetch_article",
  "grep_vault",
  "read_vault",
]);

function renderArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const lines: string[] = [];

  if (toolName === "write_episode") {
    pushString(lines, "brief", record.brief);
    pushObservations(lines, record.observations);
  } else if (
    toolName === "create_storyline" ||
    toolName === "advance_storyline" ||
    toolName === "set_storyline_status" ||
    toolName === "merge_storylines"
  ) {
    pushString(lines, "kind", record.kind);
    pushString(lines, "title", record.title);
    pushString(lines, "id", record.id);
    pushString(lines, "keep_id", record.keep_id);
    pushStringArray(lines, "merge_ids", record.merge_ids);
    pushString(lines, "status", record.status);
    pushString(lines, "summary", record.summary);
    pushString(lines, "current_tension", record.current_tension);
    pushString(lines, "emotional_arc", record.emotional_arc);
    pushStringArray(lines, "people", record.people);
    pushStringArray(lines, "source_episode_ids", record.source_episode_ids);
    pushString(lines, "reason", record.reason);
  } else if (toolName === "get_storyline") {
    pushString(lines, "id", record.id);
  } else if (toolName === "search_memory") {
    pushString(lines, "query", record.query);
    pushNumber(lines, "limit", record.limit);
  } else if (toolName === "web_search") {
    pushString(lines, "query", record.query);
    pushNumber(lines, "limit", record.limit);
  } else if (toolName === "fetch_article") {
    pushString(lines, "url", record.url);
  } else if (toolName === "send_checkin") {
    pushString(lines, "text", record.text);
  } else if (toolName === "update_profile") {
    pushString(lines, "operation", record.operation);
    pushString(lines, "old_text", record.old_text);
    pushString(lines, "new_text", record.new_text);
    pushString(lines, "reason", record.reason);
    pushStringArray(lines, "source_episode_ids", record.source_episode_ids);
  } else if (toolName === "set_chapter") {
    pushString(lines, "content", record.content, 800);
    pushString(lines, "reason", record.reason);
    pushStringArray(lines, "source_storyline_ids", record.source_storyline_ids);
    pushStringArray(lines, "source_episode_ids", record.source_episode_ids);
  } else if (toolName === "save_to_garden") {
    pushString(lines, "title", record.title);
    pushString(lines, "domain", record.domain);
    pushString(lines, "brief", record.brief);
    pushString(lines, "source_url", record.source_url);
    pushStringArray(lines, "tags", record.tags);
    pushString(lines, "body", record.body, 800);
  } else if (toolName === "grep_vault") {
    pushString(lines, "query", record.query);
    pushString(lines, "scope", record.scope);
  } else if (toolName === "read_vault") {
    pushString(lines, "path", record.path);
  } else if (toolName === "update_frontmatter") {
    pushString(lines, "path", record.path);
    pushString(lines, "frontmatter_json", record.frontmatter_json, 600);
  } else if (toolName === "promote") {
    pushString(lines, "path", record.path);
    pushString(lines, "my_note", record.my_note);
  }

  if (lines.length > 0) return lines.join("\n");
  return `**Input**\n\`\`\`json\n${truncate(JSON.stringify(args, null, 2), 800)}\n\`\`\``;
}

function pushString(lines: string[], label: string, value: unknown, max = 240): void {
  if (typeof value === "string" && value) {
    lines.push(`**${label}** ${truncate(value, max)}`);
  }
}

function pushNumber(lines: string[], label: string, value: unknown): void {
  if (typeof value === "number") {
    lines.push(`**${label}** ${value}`);
  }
}

function pushStringArray(lines: string[], label: string, value: unknown): void {
  if (Array.isArray(value) && value.length > 0) {
    const items = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (items.length > 0) {
      lines.push(`**${label}** ${truncate(items.join(", "), 360)}`);
    }
  }
}

function pushObservations(lines: string[], value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) return;
  const observations = value
    .map((item, index) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text : "";
      const evidence = typeof record.evidence === "string" ? record.evidence : "";
      const tag = typeof record.tag === "string" ? record.tag : "";
      if (!text && !evidence) return "";
      const title = tag ? `${index + 1}. [${tag}] ${truncate(text, 280)}` : `${index + 1}. ${truncate(text, 280)}`;
      return evidence ? `${title}\n   evidence: ${truncate(evidence, 360)}` : title;
    })
    .filter(Boolean);
  if (observations.length > 0) {
    lines.push(`**observations**\n${observations.join("\n")}`);
  }
}

function summarizeArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const pick = (key: string): string => {
    const value = record[key];
    return typeof value === "string" ? truncate(value.replace(/\s+/g, " "), 80) : "";
  };

  if (
    toolName === "create_storyline" ||
    toolName === "advance_storyline" ||
    toolName === "set_storyline_status" ||
    toolName === "merge_storylines"
  ) {
    const name = pick("title") || pick("id") || pick("keep_id");
    const status = pick("status");
    return status && name ? `${name} → ${status}` : name;
  }
  if (toolName === "search_memory") return pick("query");
  if (toolName === "get_storyline") return pick("id");
  if (toolName === "web_search") return pick("query");
  if (toolName === "fetch_article") return pick("url");
  if (toolName === "grep_vault") return pick("query");
  if (
    toolName === "read_vault" ||
    toolName === "update_frontmatter" ||
    toolName === "promote"
  ) {
    return pick("path");
  }
  if (toolName === "save_to_garden") return pick("title");
  if (toolName === "update_profile") return pick("operation");
  return "";
}

function shouldShowToolOutput(toolName: string): boolean {
  return TOOLS_WITH_VISIBLE_OUTPUT.has(toolName);
}

function stripToolDetails(output: string): string {
  return output
    .split("\n")
    .filter((line) => !line.startsWith("details: "))
    .join("\n")
    .trim();
}

function toolLabel(toolName: string): string {
  const label: Record<string, string> = {
    write_episode: "写 Episode",
    get_storyline: "查看 Storyline",
    create_storyline: "新建 Storyline",
    advance_storyline: "推进 Storyline",
    set_storyline_status: "设置 Storyline 状态",
    merge_storylines: "合并 Storyline",
    update_profile: "更新画像",
    set_chapter: "更新当前主线",
    search_memory: "搜索记忆",
    send_checkin: "发送轻触达",
    web_search: "搜索网页",
    fetch_article: "抓取文章",
    save_to_garden: "保存知识",
    grep_vault: "检索 Vault",
    read_vault: "读取 Vault",
    update_frontmatter: "更新 Frontmatter",
    promote: "晋升知识",
  };
  return label[toolName] ?? toolName;
}

function dateFormat(date: string): string {
  return businessDateKey(new Date(date));
}

function markdown(content: string): object {
  return { tag: "markdown", content };
}

function note(content: string): object {
  return { tag: "markdown", content, text_size: "notation" };
}

function metricsText(m: AgentCardMetrics): string {
  const used = formatTokens(m.totalTokens);
  const total = formatTokens(m.contextWindow);
  const pct = Math.round((m.totalTokens / m.contextWindow) * 100);
  const secs = (m.elapsedMs / 1000).toFixed(1);
  return `ctx: ${used}/${total}(${pct}%) · ${secs}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function footerText(footer: NonNullable<AgentCardState["footer"]>): string {
  if (footer === "thinking") return "思考中…";
  if (footer === "tool_running") return "正在调用工具…";
  return "正在输出…";
}

function summaryText(state: AgentCardState): string {
  if (state.terminal === "error") return "出错";
  if (state.terminal === "done") return "已完成";
  if (state.footer === "tool_running") return "正在调用工具";
  if (state.footer === "streaming") return "正在输出";
  return "思考中";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
