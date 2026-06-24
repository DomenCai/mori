// 每两小时拉取 aihot 精选动态，聚合成一篇 digest 投递到 Inbox/飞书。
// 用同目录下的 .aihot-state.json 记录上次已推送的最大 publishedAt 做增量去重，
// 本窗口无新增时返回 null（框架会静默跳过，不写文件、不推卡片）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://aihot.virxact.com/api/public/items";
const SOURCE_HOME = "https://aihot.virxact.com";
const STATE_FILE = join(import.meta.dirname, ".aihot-state.json");
const TZ = "Asia/Shanghai";
const MAX_SINCE_DAYS = 7; // 接口 since 最多回看 7 天
const FETCH_TIMEOUT_MS = 15_000;

const CATEGORY_LABEL = {
  "ai-models": "模型",
  "ai-products": "产品",
  industry: "行业",
  paper: "论文",
  tip: "技巧",
};

function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return typeof raw?.lastPublishedAt === "string" ? raw.lastPublishedAt : null;
  } catch {
    return null; // 首次运行，无 state
  }
}

function writeState(lastPublishedAt) {
  writeFileSync(STATE_FILE, JSON.stringify({ lastPublishedAt }, null, 2) + "\n", {
    mode: 0o600,
  });
}

function computeSince(lastPublishedAt) {
  const floor = Date.now() - MAX_SINCE_DAYS * 86_400_000;
  const fallback = Date.now() - 4 * 3_600_000; // 首次运行只取近 2 小时，避免灌库
  const base = lastPublishedAt ? Date.parse(lastPublishedAt) : fallback;
  return new Date(Math.max(base, floor)).toISOString();
}

function fmtTitleTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export default async function () {
  const lastPublishedAt = readState();
  const since = computeSince(lastPublishedAt);

  const url = `${API}?mode=selected&since=${encodeURIComponent(since)}&take=100`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`aihot 请求失败 ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];

  // 严格只保留比上次锚点更新的条目，跨窗口去重
  const anchor = lastPublishedAt ? Date.parse(lastPublishedAt) : 0;
  const fresh = items
    .filter((it) => it?.publishedAt && Date.parse(it.publishedAt) > anchor)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  if (fresh.length === 0) return null;

  const maxPublishedAt = fresh.reduce(
    (max, it) => (Date.parse(it.publishedAt) > Date.parse(max) ? it.publishedAt : max),
    fresh[0].publishedAt,
  );
  writeState(maxPublishedAt);

  const lines = fresh.map((it) => {
    const cat = CATEGORY_LABEL[it.category] ?? it.category ?? "";
    const tag = cat ? ` \`${cat}\`` : "";
    const summary = it.summary ? `\n  ${it.summary}` : "";
    const source = it.source ? `[${it.source}](${it.url})` : "";
    return `### ${it.title}
${source} · ${tag}  

${it.summary}  
`;
    // return `- **[${it.title}](${it.url})**${tag} · ${it.source ?? ""}${summary}`;
  });

  return {
    title: `AI 精选动态 · ${fmtTitleTime(new Date())}`,
    domain: "AI 精选",
    tags: [...new Set(fresh.map((it) => CATEGORY_LABEL[it.category] ?? it.category).filter(Boolean))],
    brief: `本次新增 ${fresh.length} 条精选动态。`,
    body: lines.join("\n\n---\n\n"),
    source_url: SOURCE_HOME,
  };
}
