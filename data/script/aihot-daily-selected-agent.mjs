// 每天取过去 24 小时的 aihot 精选动态，让 agent 选出最值得看的 10 条。
const API = "https://aihot.virxact.com/api/public/items";
const SOURCE_HOME = "https://aihot.virxact.com";
const TZ = "Asia/Shanghai";
const FETCH_TIMEOUT_MS = 15_000;
const WINDOW_HOURS = 24;
const TAKE = 100;
const TARGET_COUNT = 10;

const CATEGORY_LABEL = {
  "ai-models": "模型",
  "ai-products": "产品",
  industry: "行业",
  paper: "论文",
  tip: "技巧",
};

function fmtLocal(date, options) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ,
    ...options,
  }).format(date);
}

function fmtTitleTime(date) {
  return fmtLocal(date, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtWindowDate(date) {
  return fmtLocal(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function categoryLabel(category) {
  return CATEGORY_LABEL[category] ?? category ?? "";
}

function normalizeItem(item) {
  return {
    id: item.id,
    title: item.title,
    title_en: item.title_en,
    url: item.url,
    permalink: item.permalink,
    source: item.source,
    publishedAt: item.publishedAt,
    category: item.category,
    categoryLabel: categoryLabel(item.category),
    score: item.score,
    summary: item.summary,
  };
}

function renderSelected(items, windowStart, windowEnd) {
  const lines = items.map((item, index) => {
    const cat = item.categoryLabel ? ` \`${item.categoryLabel}\`` : "";
    const source = item.source ? `[${item.source}](${item.url})` : `[原文](${item.url})`;
    return `### ${index + 1}. ${item.title}
${source} · ${fmtTitleTime(new Date(item.publishedAt))}${cat}

${item.summary}`;
  });

  return `过去 24 小时窗口：${fmtWindowDate(windowStart)} - ${fmtWindowDate(windowEnd)}

${lines.join("\n\n---\n\n")}`;
}

async function fetchItems() {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - WINDOW_HOURS * 3_600_000);
  const url = `${API}?mode=selected&since=${encodeURIComponent(windowStart.toISOString())}&take=${TAKE}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`aihot 请求失败 ${res.status}`);

  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  const normalized = items
    .filter((item) => item?.id && item?.title && item?.publishedAt && item?.summary)
    .map(normalizeItem)
    .sort((a, b) => {
      const scoreDelta = (Number(b.score) || 0) - (Number(a.score) || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });

  return { items: normalized, windowStart, windowEnd };
}

export default async function ({ Type }) {
  const { items, windowStart, windowEnd } = await fetchItems();
  if (items.length === 0) return null;

  let selectedIds = [];
  const validIds = new Set(items.map((item) => item.id));
  const targetCount = Math.min(TARGET_COUNT, items.length);

  return {
    system: "bare",
    prompt: `你是我的 AI 动态编辑。请从下面过去 24 小时的 aihot 精选候选中，选出最值得我看的 ${targetCount} 条。

选择标准：
- 优先选择对 AI 产品、模型能力、开发者工具、产业变化有长期价值或行动价值的内容。
- 降低纯营销、重复发布、信息密度低、只适合随手一看的内容优先级。
- 保持主题多样性，不要只选同一类。
- 只调用 select_aihot_items 工具提交最终选择，ids 数量必须是 ${targetCount}。
- 不要输出任何正文、解释、标题或选择依据；工具提交后直接结束。

候选 JSON：
${JSON.stringify(items, null, 2)}`,
    tools: [
      {
        name: "select_aihot_items",
        label: "选择 AIHot 精选",
        description: `提交最终选中的 ${targetCount} 条 aihot item ID。`,
        parameters: Type.Object({
          ids: Type.Array(Type.String(), {
            description: `按推荐阅读顺序排列的 ${targetCount} 个 item id`,
          }),
        }),
        execute: async (_id, params) => {
          const ids = params.ids;
          if (ids.length !== targetCount) {
            throw new Error(`必须选择 ${targetCount} 条，当前 ${ids.length} 条`);
          }
          const invalid = ids.filter((id) => !validIds.has(id));
          if (invalid.length > 0) {
            throw new Error(`存在无效 id: ${invalid.join(", ")}`);
          }
          const uniqueIds = [...new Set(ids)];
          if (uniqueIds.length !== ids.length) {
            throw new Error("选择结果里有重复 id");
          }
          selectedIds = uniqueIds;
          return {
            content: [{ type: "text", text: `已选择 ${selectedIds.length} 条` }],
            details: { ids: selectedIds },
            terminate: true,
          };
        },
      },
    ],
    result: async () => {
      if (selectedIds.length === 0) {
        throw new Error("agent 未调用 select_aihot_items 提交选择");
      }
      const rank = new Map(selectedIds.map((id, index) => [id, index]));
      const selected = items
        .filter((item) => rank.has(item.id))
        .sort((a, b) => rank.get(a.id) - rank.get(b.id));

      return {
        title: `AI 每日精选 · ${fmtTitleTime(windowEnd)}`,
        domain: "AI 精选",
        tags: [...new Set(selected.map((item) => item.categoryLabel).filter(Boolean))],
        brief: `从过去 24 小时 ${items.length} 条 aihot 精选中挑出 ${selected.length} 条。`,
        body: renderSelected(selected, windowStart, windowEnd),
        source_url: SOURCE_HOME,
      };
    },
  };
}
