import type { AgentTool } from "@earendil-works/pi-agent-core";
import { WebSearchParams, type WebSearchData } from "../schemas.js";
import { loadSetting } from "../../config.js";

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

interface SearchRuntimeConfig {
  provider: "tavily" | "brave";
  apiKey: string;
  timeoutMs: number;
  userAgent: string;
}

export function isWebSearchConfigured(): boolean {
  return getSearchRuntimeConfig() !== null;
}

export function createWebSearchTool(): AgentTool<typeof WebSearchParams> {
  return {
    name: "web_search",
    label: "搜索网页",
    description:
      "按关键词搜索网页，返回标题、URL、摘要；Tavily 结果可能带清洗正文，Brave 只返回链接和摘要。",
    parameters: WebSearchParams,
    execute: async (_id, params) => {
      const config = searchRuntimeConfig();
      const limit = normalizeLimit(params.limit);
      const results = await webSearch(config, params.query, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results),
          },
        ],
        details: {
          provider: config.provider,
          query: params.query,
          resultCount: results.length,
        },
      };
    },
  };
}

async function webSearch(
  config: SearchRuntimeConfig,
  query: string,
  limit: number,
): Promise<WebSearchResult[]> {
  switch (config.provider) {
    case "tavily":
      return searchTavily(config, query, limit);
    case "brave":
      return searchBrave(config, query, limit);
  }
}

async function searchTavily(
  config: SearchRuntimeConfig,
  query: string,
  limit: number,
): Promise<WebSearchResult[]> {
  const response = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "user-agent": config.userAgent,
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        search_depth: "basic",
        include_raw_content: true,
      }),
    },
    config.timeoutMs,
  );
  const data = await readJson(response, "Tavily 搜索失败");
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((item) => {
    const record = item as Record<string, unknown>;
    const rawContent = asString(record.raw_content);
    return {
      title: asString(record.title) || asString(record.url),
      url: asString(record.url),
      snippet: asString(record.content),
      ...(rawContent ? { content: rawContent } : {}),
    };
  }).filter((item) => item.url);
}

async function searchBrave(
  config: SearchRuntimeConfig,
  query: string,
  limit: number,
): Promise<WebSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        accept: "application/json",
        "x-subscription-token": config.apiKey,
        "user-agent": config.userAgent,
      },
    },
    config.timeoutMs,
  );
  const data = await readJson(response, "Brave 搜索失败");
  const web = data.web as Record<string, unknown> | undefined;
  const webResults = web?.results;
  const results = Array.isArray(webResults) ? webResults : [];
  return results.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      title: asString(record.title) || asString(record.url),
      url: asString(record.url),
      snippet: asString(record.description),
    };
  }).filter((item) => item.url);
}

function searchRuntimeConfig(): SearchRuntimeConfig {
  const config = getSearchRuntimeConfig();
  if (!config) {
    throw new Error("web_search 未配置：请设置 setting.knowledge.search 和对应环境变量");
  }
  return config;
}

function getSearchRuntimeConfig(): SearchRuntimeConfig | null {
  const setting = loadSetting();
  const search = (setting as {
    knowledge?: { search?: unknown };
  }).knowledge?.search;
  if (!isSearchConfig(search)) return null;

  const apiKey = process.env[search.apiKeyEnv]?.trim();
  if (!apiKey) return null;

  return {
    provider: search.provider,
    apiKey,
    timeoutMs: setting.http.fetch.timeoutMs,
    userAgent: setting.http.fetch.userAgent,
  };
}

function isSearchConfig(value: unknown): value is {
  provider: "tavily" | "brave";
  apiKeyEnv: string;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === "tavily" || record.provider === "brave") &&
    typeof record.apiKeyEnv === "string" &&
    record.apiKeyEnv.length > 0
  );
}

function normalizeLimit(limit: WebSearchData["limit"]): number {
  if (!limit) return 5;
  return Math.max(1, Math.min(Math.floor(limit), 10));
}

function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...init,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

async function readJson(
  response: Response,
  errorPrefix: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${errorPrefix} ${response.status}: ${text.slice(0, 300)}`);
  }
  return await response.json() as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
