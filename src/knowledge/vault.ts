import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { knowledgeIndexPath, loadSetting, vaultDir } from "../config.js";
import { nowISO, businessDateKey } from "../utils.js";

const execFileAsync = promisify(execFile);

export interface KnowledgeArticle {
  title: string;
  domain: string;
  tags?: string[];
  brief: string;
  body: string;
  source_url?: string;
}

export interface VaultFile {
  path: string;
  frontmatter: Record<string, any>;
  body: string;
}

export class VaultService {
  constructor(private root = vaultDir) {}

  ensureBaseDirs(): void {
    mkdirSync(join(this.root, "Inbox"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "Garden"), { recursive: true, mode: 0o700 });
  }

  writeInbox(
    inboxName: string,
    slug: string,
    article: KnowledgeArticle,
  ): { path: string; existed: boolean } {
    this.ensureBaseDirs();
    const dir = join(this.root, "Inbox", inboxName, monthKey(),);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${slug}.md`);
    const relPath = this.toRelative(file);
    if (existsSync(file)) return { path: relPath, existed: true };
    writeFileSync(file, renderMarkdown(article, "inbox"), { mode: 0o600 });
    return { path: relPath, existed: false };
  }

  saveToGarden(
    article: KnowledgeArticle,
    slug = slugify(article.title),
  ): { path: string; existed: boolean } {
    this.ensureBaseDirs();
    const dir = join(this.root, "Garden", monthKey());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = uniquePath(join(dir, `${slug}.md`));
    const existed = existsSync(file);
    if (!existed) {
      writeFileSync(file, renderMarkdown(article, "kept"), { mode: 0o600 });
    }
    return { path: this.toRelative(file), existed };
  }

  promote(relPath: string, fields: Record<string, any> = {}): string {
    this.ensureBaseDirs();
    if (relPath.startsWith("Garden/")) {
      this.updateFrontmatter(relPath, {
        ...fields,
        status: "kept",
        reacted_at: fields.reacted_at ?? nowISO(),
      });
      return relPath;
    }

    const source = this.resolve(relPath);
    const dir = join(this.root, "Garden", monthKey());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = uniquePath(join(dir, basename(source)));

    renameSync(source, target);
    const targetRelPath = this.toRelative(target);
    this.updateFrontmatter(targetRelPath, {
      ...fields,
      status: "kept",
      reacted_at: fields.reacted_at ?? nowISO(),
    });
    return targetRelPath;
  }

  updateFrontmatter(relPath: string, fields: Record<string, any>): void {
    const file = this.resolve(relPath);
    const raw = readFileSync(file, "utf-8");
    const parsed = parseMarkdown(raw);
    writeFileSync(
      file,
      replaceFrontmatter(raw, { ...parsed.frontmatter, ...fields }),
      { mode: 0o600 },
    );
  }

  read(relPath: string): VaultFile {
    const file = this.resolve(relPath);
    const raw = readFileSync(file, "utf-8");
    const parsed = parseMarkdown(raw);
    return {
      path: this.toRelative(file),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    };
  }

  async grep(query: string, scope?: string): Promise<string> {
    this.ensureBaseDirs();
    const target = scope ? this.resolve(scope) : this.root;
    try {
      const { stdout } = await execFileAsync("rg", [
        "--line-number",
        "--fixed-strings",
        query,
        target,
      ]);
      return stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, 20)
        .map((line) => line.replace(`${this.root}/`, ""))
        .join("\n");
    } catch {
      return fallbackGrep(target, query, this.root);
    }
  }

  listFrontmatter(): VaultFile[] {
    this.ensureBaseDirs();
    return walkMarkdown(this.root)
      .filter((file) => this.toRelative(file) !== ".index.md")
      .map((file) => {
        const relPath = this.toRelative(file);
        const raw = readFileSync(file, "utf-8");
        const parsed = parseMarkdown(raw);
        return {
          path: relPath,
          frontmatter: parsed.frontmatter,
          body: "",
        };
      });
  }

  buildDeterministicIndex(): string {
    const files = this.listFrontmatter().filter((file) => file.path !== ".index.md");
    const groups = new Map<string, VaultFile[]>();
    for (const file of files) {
      const domain = String(file.frontmatter.domain ?? "未分类");
      groups.set(domain, [...(groups.get(domain) ?? []), file]);
    }

    const lines = ["# 知识地图", "", `updated_at: ${nowISO()}`, ""];
    for (const [domain, group] of [...groups.entries()].sort()) {
      lines.push(`## ${domain}（${group.length} 篇）`);
      const tags = new Set<string>();
      for (const file of group) {
        for (const tag of Array.isArray(file.frontmatter.tags) ? file.frontmatter.tags : []) {
          tags.add(String(tag));
        }
      }
      if (tags.size > 0) lines.push(`tags: ${[...tags].slice(0, 12).join(", ")}`);
      for (const file of group.slice(0, 8)) {
        lines.push(
          `- ${file.frontmatter.title ?? file.path}: ${file.frontmatter.brief ?? "无摘要"} (${file.path})`,
        );
      }
      lines.push("");
    }

    mkdirSync(dirname(knowledgeIndexPath), { recursive: true, mode: 0o700 });
    writeFileSync(knowledgeIndexPath, lines.join("\n").trim() + "\n", {
      mode: 0o600,
    });
    return knowledgeIndexPath;
  }

  writeKnowledgeIndex(content: string): string {
    mkdirSync(dirname(knowledgeIndexPath), { recursive: true, mode: 0o700 });
    writeFileSync(knowledgeIndexPath, content.trim() + "\n", {
      mode: 0o600,
    });
    return knowledgeIndexPath;
  }

  toRelative(absPath: string): string {
    return relative(resolvePath(this.root), resolvePath(absPath));
  }

  resolve(relPath: string): string {
    const root = resolvePath(this.root);
    const abs = resolvePath(root, relPath);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`vault 路径越界：${relPath}`);
    }
    return abs;
  }
}

export async function fetchArticle(url: string): Promise<KnowledgeArticle> {
  const { timeoutMs, userAgent } = loadSetting().http.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": userAgent,
      },
    });
    if (!response.ok) {
      throw new Error(`抓取失败 ${response.status}: ${url}`);
    }
    const html = await response.text();
    const title = extractTitle(html) ?? url;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return {
      title,
      domain: "未分类",
      tags: [],
      brief: text.slice(0, 160) || title,
      body: `# ${title}\n\n${text}`,
      source_url: url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || `note-${Date.now().toString(36)}`;
}

function renderMarkdown(article: KnowledgeArticle, status: "inbox" | "kept"): string {
  return renderParsed(
    {
      title: article.title,
      domain: article.domain,
      tags: article.tags ?? [],
      brief: article.brief,
      status,
      source_url: article.source_url,
      saved_at: nowISO(),
    },
    article.body,
  );
}

function renderParsed(frontmatter: Record<string, any>, body: string): string {
  return `${renderFrontmatter(frontmatter)}${body.trim()}\n`;
}

function renderFrontmatter(frontmatter: Record<string, any>): string {
  const yaml = stringify(frontmatter).trim();
  return `---\n${yaml}\n---\n`;
}

function replaceFrontmatter(raw: string, frontmatter: Record<string, any>): string {
  const parsed = parseMarkdown(raw);
  return `${renderFrontmatter(frontmatter)}${raw.slice(parsed.bodyStart)}`;
}

function parseMarkdown(raw: string): {
  frontmatter: Record<string, any>;
  body: string;
  bodyStart: number;
} {
  const bounds = frontmatterBounds(raw);
  const yamlText = raw.slice(bounds.frontmatterStart, bounds.frontmatterEnd);
  return {
    frontmatter: (parse(yamlText) as Record<string, any>) ?? {},
    body: raw.slice(bounds.bodyStart),
    bodyStart: bounds.bodyStart,
  };
}

function frontmatterBounds(raw: string): {
  frontmatterStart: number;
  frontmatterEnd: number;
  bodyStart: number;
} {
  const frontmatterStart = raw.startsWith("---\n")
    ? 4
    : raw.startsWith("---\r\n")
      ? 5
      : -1;
  if (frontmatterStart < 0) {
    throw new Error("vault 文件缺少 frontmatter");
  }

  let lineStart = frontmatterStart;
  while (lineStart < raw.length) {
    const lineEnd = raw.indexOf("\n", lineStart);
    const lineTextEnd = lineEnd < 0 ? raw.length : lineEnd;
    const line = raw.slice(lineStart, lineTextEnd).replace(/\r$/, "");
    if (line === "---") {
      return {
        frontmatterStart,
        frontmatterEnd: lineStart,
        bodyStart: lineEnd < 0 ? raw.length : lineEnd + 1,
      };
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }

  throw new Error("vault frontmatter 未闭合");
}

function monthKey(date = new Date()): string {
  return businessDateKey(date).slice(0, 7);
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`无法生成唯一文件名：${path}`);
}

function walkMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return root.endsWith(".md") ? [root] : [];
  return readdirSync(root)
    .flatMap((name) => walkMarkdown(join(root, name)));
}

function fallbackGrep(target: string, query: string, root: string): string {
  const files = walkMarkdown(target);
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (line.includes(query)) {
        hits.push(`${relative(root, file)}:${index + 1}:${line}`);
      }
    });
  }
  return hits.slice(0, 20).join("\n");
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim();
}
