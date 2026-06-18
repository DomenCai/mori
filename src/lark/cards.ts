export function renderMarkdownCard(content: string): object {
  return {
    schema: "2.0",
    body: {
      elements: [{ tag: "markdown", content }],
    },
  };
}

export function renderThinkingCard(): object {
  return renderMarkdownCard("思考中…");
}

export function renderToolCard(toolName: string, status: "running" | "done"): object {
  const label: Record<string, string> = {
    write_episode: "写 Episode",
    upsert_working_item: "更新工作集",
    update_profile: "更新画像",
    search_diary: "搜索日记",
  };
  const icon = status === "running" ? "⏳" : "✅";
  return renderMarkdownCard(`${icon} ${label[toolName] ?? toolName}`);
}
