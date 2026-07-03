const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export default async function run(ctx) {
  if (!ctx?.diary) {
    throw new Error("此脚本需要在 schedules.json 配置 context: [\"diary\"]");
  }

  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * DAY_MS);
  const entries = await ctx.diary.export({
    start: start.toISOString(),
    end: end.toISOString(),
  });

  return {
    title: "最近一个月日记导出",
    body: renderExport(entries, start, end),
  };
}

function renderExport(entries, start, end) {
  const lines = [
    "# 最近一个月日记导出",
    "",
    `窗口：${start.toISOString()} - ${end.toISOString()}`,
    `数量：${entries.length} 篇`,
    "",
  ];

  for (const entry of entries) {
    lines.push(
      "---",
      "",
      `## ${formatLocal(entry.occurredAt)} · ${entry.id}`,
      "",
      "### 日记",
      "",
      entry.content.trim() || "（空）",
      "",
    );

    lines.push("### AI 回复", "");
    if (entry.aiReplies.length === 0) {
      lines.push("（无）", "");
    } else {
      for (const reply of entry.aiReplies) {
        lines.push(`#### ${formatLocal(reply.occurredAt)} · ${reply.id}`, "");
        lines.push(reply.content.trim() || "（空）", "");
      }
    }

    lines.push("### Episode", "");
    if (entry.episodes.length === 0) {
      lines.push("（无）", "");
    } else {
      for (const episode of entry.episodes) {
        lines.push(`#### ${episode.id}`, "");
        if (episode.brief) lines.push(`摘要：${episode.brief}`, "");
        lines.push(...renderEpisodeAnalysis(episode.analysis), "");
      }
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function renderEpisodeAnalysis(analysis) {
  const observations = Array.isArray(analysis?.observations)
    ? analysis.observations
    : [];
  if (observations.length === 0) return ["（无结构化 observations）"];

  return observations.map((item) => {
    const tag = item?.tag ? ` \`${item.tag}\`` : "";
    const text = String(item?.text ?? "").trim();
    const evidence = String(item?.evidence ?? "").trim();
    return `- ${text || "（空 observation）"}${tag}${evidence ? `\n  - evidence: ${evidence}` : ""}`;
  });
}

function formatLocal(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
