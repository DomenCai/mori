import { businessDateTime, summarizeTextDelta } from "../utils.js";

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

// 斜杠命令的展示卡片：带蓝色标题栏 + 一段 markdown 正文。
export function renderInfoCard(title: string, body: string): object {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    body: { elements: [markdown(body)] },
  };
}

// 画像变更历史卡：每条 = 业务时区时间 · 原因 + 简洁 delta。
export function renderProfileHistoryCard(
  rows: Array<{ old_content: string | null; new_content: string; reason: string; created_at: string }>,
): object {
  const elements: object[] = rows.length
    ? rows.map((r) =>
        markdown(
          `**${businessDateTime(new Date(r.created_at))}** · ${r.reason}\n${summarizeTextDelta(r.old_content ?? "", r.new_content)}`,
        ),
      )
    : [markdown("暂无画像变更历史")];
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "📋 身份画像历史" }, template: "blue" },
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

function collapsiblePanel(title: string, body: string): object {
  return {
    tag: "collapsible_panel",
    expanded: false,
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
    search_memory: "搜索记忆",
    send_checkin: "发送轻触达",
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

  if (tool.output) {
    const label = tool.status === "error" ? "Error" : "Output";
    parts.push(`**${label}**\n\`\`\`\n${truncate(tool.output, 1200)}\n\`\`\``);
  } else if (tool.status === "running") {
    parts.push("_运行中…_");
  }

  return parts.join("\n\n") || "_无输出_";
}

function renderArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const lines: string[] = [];

  if (toolName === "write_episode") {
    pushString(lines, "brief", record.brief);
  } else if (
    toolName === "create_storyline" ||
    toolName === "advance_storyline" ||
    toolName === "set_storyline_status" ||
    toolName === "merge_storylines"
  ) {
    pushString(lines, "title", record.title);
    pushString(lines, "id", record.id);
    pushString(lines, "status", record.status);
    pushString(lines, "summary", record.summary);
    pushString(lines, "reason", record.reason);
  } else if (toolName === "search_memory") {
    pushString(lines, "query", record.query);
  } else if (toolName === "send_checkin") {
    pushString(lines, "text", record.text);
  } else if (toolName === "update_profile") {
    pushString(lines, "operation", record.operation);
    pushString(lines, "reason", record.reason);
  }

  if (lines.length > 0) return lines.join("\n");
  return `**Input**\n\`\`\`json\n${truncate(JSON.stringify(args, null, 2), 800)}\n\`\`\``;
}

function pushString(lines: string[], label: string, value: unknown): void {
  if (typeof value === "string" && value) {
    lines.push(`**${label}** ${truncate(value, 240)}`);
  }
}

function summarizeArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const pick = (key: string): string => {
    const value = record[key];
    return typeof value === "string" ? truncate(value.replace(/\s+/g, " "), 80) : "";
  };

  if (toolName === "write_episode") return pick("brief");
  if (
    toolName === "create_storyline" ||
    toolName === "advance_storyline" ||
    toolName === "set_storyline_status" ||
    toolName === "merge_storylines"
  ) {
    const name = pick("title") || pick("id");
    const status = pick("status");
    return status && name ? `${name} → ${status}` : name;
  }
  if (toolName === "search_memory") return pick("query");
  if (toolName === "send_checkin") return pick("text");
  if (toolName === "update_profile") return pick("reason");
  return "";
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
    search_memory: "搜索记忆",
    send_checkin: "发送轻触达",
    fetch_article: "抓取文章",
    save_to_garden: "保存知识",
    grep_vault: "检索 Vault",
    read_vault: "读取 Vault",
    update_frontmatter: "更新 Frontmatter",
    promote: "晋升知识",
  };
  return label[toolName] ?? toolName;
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
