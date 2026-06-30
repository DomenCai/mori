import { execFile } from "node:child_process";
import { promisify } from "util";
import { loadSetting } from "../config.js";

const execFileAsync = promisify(execFile);

export interface KnowledgeArticle {
  title: string;
  body: string;
  source_url: string;
  fetch_status: "ok" | "failed";
}

export async function fetchArticle(
  url: string,
  rawClient?: unknown,
): Promise<KnowledgeArticle> {
  try {
    if (isFeishuUrl(url)) {
      const feishu = await fetchFeishuArticle(url, rawClient);
      return feishu ?? {
        title: url,
        body: "",
        source_url: url,
        fetch_status: "failed",
      };
    }
    return await fetchDefuddleArticle(url);
  } catch {
    return {
      title: url,
      body: "",
      source_url: url,
      fetch_status: "failed",
    };
  }
}

function isFeishuUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname;
    return host.endsWith(".feishu.cn") || host.endsWith(".larksuite.com");
  } catch {
    return false;
  }
}

async function fetchDefuddleArticle(url: string): Promise<KnowledgeArticle> {
  const { timeoutMs } = loadSetting().http.fetch;
  try {
    let parsed = await execJsonWithNpxFallback("defuddle", ["parse", url, "-j"], timeoutMs);
    if (!asTrimmedString(parsed.contentMarkdown)) {
      parsed = await execJsonWithNpxFallback("defuddle", ["parse", url, "-j", "-m"], timeoutMs);
    }
    const title = typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : url;
    const body =
      asTrimmedString(parsed.contentMarkdown)
      || asTrimmedString(parsed.content)
      || await fetchDucksearchArticle(url, timeoutMs);
    return {
      title,
      body,
      source_url: url,
      fetch_status: body ? "ok" : "failed",
    };
  } catch (error) {
    warnVault(`defuddle 抓取失败，尝试 ducksearch 兜底: ${formatErrorMessage(error)}`);
    const body = await fetchDucksearchArticle(url, timeoutMs);
    return {
      title: url,
      body,
      source_url: url,
      fetch_status: body ? "ok" : "failed",
    };
  }
}

async function fetchFeishuArticle(
  url: string,
  rawClient: unknown,
): Promise<KnowledgeArticle | null> {
  if (!rawClient) return null;
  const client = rawClient as FeishuClient;
  const ref = await resolveFeishuDocumentRef(url, client);
  if (!ref) return null;
  const rawContent = client.docx?.v1?.document?.rawContent;
  if (!rawContent) return null;
  const result = await rawContent({ path: { document_id: ref.token } });
  const response = result as { code?: unknown; data?: { content?: unknown } };
  if (response.code !== undefined && response.code !== 0) return null;
  const body = asTrimmedString(response.data?.content);
  return {
    title: ref.title || url,
    body,
    source_url: url,
    fetch_status: body ? "ok" : "failed",
  };
}

interface FeishuClient {
  docx?: {
    v1?: {
      document?: {
        rawContent?: (args: unknown) => Promise<unknown>;
      };
    };
  };
  wiki?: {
    v2?: {
      space?: {
        getNode?: (args: unknown) => Promise<unknown>;
      };
    };
  };
}

interface FeishuDocumentRef {
  token: string;
  title?: string;
}

async function resolveFeishuDocumentRef(
  input: string,
  client: FeishuClient,
): Promise<FeishuDocumentRef | null> {
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    const docMarker = parts.findIndex((part) => part === "docx" || part === "docs");
    if (docMarker >= 0 && parts[docMarker + 1]) return { token: parts[docMarker + 1] };

    const wikiMarker = parts.findIndex((part) => part === "wiki");
    const nodeToken = wikiMarker >= 0 ? parts[wikiMarker + 1] : null;
    if (!nodeToken) return null;
    const getNode = client.wiki?.v2?.space?.getNode;
    if (!getNode) return null;
    const result = await getNode({ params: { token: nodeToken, obj_type: "wiki" } });
    const response = result as {
      code?: unknown;
      data?: {
        node?: {
          obj_token?: unknown;
          obj_type?: unknown;
          title?: unknown;
        };
      };
    };
    if (response.code !== undefined && response.code !== 0) return null;
    const node = response.data?.node;
    if (node?.obj_type !== "docx") return null;
    const token = asTrimmedString(node.obj_token);
    if (!token) return null;
    return {
      token,
      title: asTrimmedString(node.title) || undefined,
    };
  } catch (error) {
    warnVault(`飞书文档解析失败: ${formatErrorMessage(error)}`);
    return null;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function fetchDucksearchArticle(url: string, timeoutMs: number): Promise<string> {
  try {
    const parsed = await execJson("npx", ["-y", "ducksearch", "fetch", "-j", url], timeoutMs);
    return asTrimmedString(parsed.content);
  } catch (error) {
    warnVault(`ducksearch 兜底抓取失败: ${formatErrorMessage(error)}`);
    return "";
  }
}

async function execJsonWithNpxFallback(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  try {
    return await execJson(command, args, timeoutMs);
  } catch (error) {
    if (getExecErrorCode(error) !== "ENOENT") throw error;
    warnVault(`${command} 未安装，尝试通过 npx 执行`);
    return execJson("npx", ["-y", command, ...args], timeoutMs);
  }
}

async function execJson(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseJsonOutput(stdout);
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("命令未输出 JSON");
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function getExecErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnVault(message: string): void {
  console.warn(`[vault] ${message}`);
}
