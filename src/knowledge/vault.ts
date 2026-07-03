import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { vaultDir } from "../config.js";
import { businessDateKey, nowISO } from "../utils.js";

const execFileAsync = promisify(execFile);

export type VaultSourceType = "clip" | "conversation" | "review" | "manual";

export interface IngestNoteArgs {
  title: string;
  body: string;
  source_type: VaultSourceType;
  source_url?: string;
  origin_note?: string;
  path?: string;
  period?: string;
  covers?: string[];
}

export interface IngestNoteResult {
  path: string;
  status: "saved" | "duplicate";
  title: string;
}

export interface VaultFile {
  path: string;
  frontmatter: Record<string, any>;
  body: string;
}

export interface VaultSearchResult {
  title: string;
  source_type: string;
  saved_at: string;
  snippet: string;
  path: string;
}

export class VaultService {
  constructor(private root = vaultDir) { }

  ensureBaseDirs(): void {
    mkdirSync(join(this.root, "notes"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "reviews"), { recursive: true, mode: 0o700 });
  }

  ingestNote(args: IngestNoteArgs): IngestNoteResult {
    this.ensureBaseDirs();
    const sourceUrl = args.source_url ? canonicalizeUrl(args.source_url) : undefined;
    if (!args.path && sourceUrl) {
      const existing = this.findByCanonicalUrl(sourceUrl);
      if (existing) {
        return {
          path: existing.path,
          status: "duplicate",
          title: String(existing.frontmatter.title ?? existing.path),
        };
      }
    }

    const relPath = args.path ?? this.nextNotePath(args.title);
    const absPath = this.resolve(relPath);
    mkdirSync(dirname(absPath), { recursive: true, mode: 0o700 });
    const title = args.title.trim() || "未命名";
    const existingSavedAt = args.path && existsSync(absPath)
      ? this.safeRead(this.toRelative(absPath))?.frontmatter.saved_at
      : undefined;
    writeFileSync(
      absPath,
      renderParsed(
        cleanFrontmatter({
          title,
          source_type: args.source_type,
          source_url: sourceUrl,
          origin_note: args.origin_note,
          saved_at: typeof existingSavedAt === "string" && existingSavedAt
            ? existingSavedAt
            : nowISO(),
          period: args.period,
          covers: args.covers,
        }),
        args.body,
      ),
      { mode: 0o600 },
    );
    return { path: this.toRelative(absPath), status: "saved", title };
  }

  read(relPath: string): VaultFile {
    const file = this.resolve(relPath);
    const raw = readFileSync(file, "utf-8");
    const parsed = parseMarkdown(raw);
    return {
      path: this.toRelative(file),
      frontmatter: parsed.frontmatter,
      body: parsed.body.trim(),
    };
  }

  async search(query: string, k = 10): Promise<VaultSearchResult[]> {
    this.ensureBaseDirs();
    const limit = clampLimit(k);
    if (!query.trim()) {
      return this.listFrontmatter()
        .sort(compareSavedAtDesc)
        .slice(0, limit)
        .map((file) => ({
          title: String(file.frontmatter.title ?? file.path),
          source_type: String(file.frontmatter.source_type ?? ""),
          saved_at: String(file.frontmatter.saved_at ?? ""),
          snippet: "",
          path: file.path,
        }));
    }

    const lines = await this.grepLines(query);
    return lines.slice(0, limit).map((line) => {
      const file = this.safeRead(line.path);
      return {
        title: String(file?.frontmatter.title ?? line.path),
        source_type: String(file?.frontmatter.source_type ?? ""),
        saved_at: String(file?.frontmatter.saved_at ?? ""),
        snippet: truncate(line.text.trim(), 200),
        path: line.path,
      };
    });
  }

  listFrontmatter(): VaultFile[] {
    this.ensureBaseDirs();
    return this.listExistingFrontmatter();
  }

  listFrontmatterReadonly(): VaultFile[] {
    return this.listExistingFrontmatter();
  }

  private listExistingFrontmatter(): VaultFile[] {
    const files: VaultFile[] = [];
    for (const file of [
      ...walkMarkdown(join(this.root, "notes")),
      ...walkMarkdown(join(this.root, "reviews")),
    ]) {
      const relPath = this.toRelative(file);
      try {
        const raw = readFileSync(file, "utf-8");
        const parsed = parseMarkdown(raw);
        files.push({
          path: relPath,
          frontmatter: parsed.frontmatter,
          body: "",
        });
      } catch (error) {
        warnVault(`跳过无效 frontmatter: ${relPath}: ${formatErrorMessage(error)}`);
      }
    }
    return files;
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

  private nextNotePath(title: string): string {
    const dir = join(this.root, "notes", monthKey());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return this.toRelative(uniquePath(join(dir, `${slugify(title)}.md`)));
  }

  private findByCanonicalUrl(sourceUrl: string): VaultFile | null {
    return this.listFrontmatter().find((file) => {
      const existing = file.frontmatter.source_url;
      return typeof existing === "string" && canonicalizeUrl(existing) === sourceUrl;
    }) ?? null;
  }

  private safeRead(relPath: string): VaultFile | null {
    try {
      return this.read(relPath);
    } catch {
      return null;
    }
  }

  private async grepLines(query: string): Promise<Array<{ path: string; text: string }>> {
    const roots = [join(this.root, "notes"), join(this.root, "reviews")]
      .filter((path) => existsSync(path));
    if (roots.length === 0) return [];
    try {
      const { stdout } = await execFileAsync("rg", [
        "--line-number",
        "--fixed-strings",
        "--",
        query,
        ...roots,
      ], {
        maxBuffer: 20 * 1024 * 1024,
      });
      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parsed = parseRgLine(line, this.root);
          return parsed;
        })
        .filter((line): line is { path: string; text: string } => Boolean(line));
    } catch (error) {
      const code = getExecErrorCode(error);
      if (code === 1) return [];
      if (code === "ENOENT") return fallbackGrep(roots, query, this.root);
      warnVault(`rg 检索失败: ${formatErrorMessage(error)}`);
      return [];
    }
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

function renderParsed(frontmatter: Record<string, any>, body: string): string {
  const text = body.trim();
  return `${renderFrontmatter(frontmatter)}${text ? `${text}\n` : ""}`;
}

function renderFrontmatter(frontmatter: Record<string, any>): string {
  const yaml = stringify(frontmatter).trim();
  return `---\n${yaml}\n---\n\n`;
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
  return readdirSync(root).flatMap((name) => walkMarkdown(join(root, name)));
}

function fallbackGrep(
  roots: string[],
  query: string,
  root: string,
): Array<{ path: string; text: string }> {
  const hits: Array<{ path: string; text: string }> = [];
  for (const file of roots.flatMap(walkMarkdown)) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line) => {
      if (line.includes(query)) {
        hits.push({ path: relative(root, file), text: line });
      }
    });
  }
  return hits.slice(0, 20);
}

function parseRgLine(line: string, root: string): { path: string; text: string } | null {
  const first = line.indexOf(":");
  if (first < 0) return null;
  const second = line.indexOf(":", first + 1);
  if (second < 0) return null;
  return {
    path: relative(root, line.slice(0, first)),
    text: line.slice(second + 1),
  };
}

function cleanFrontmatter(frontmatter: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(frontmatter).filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  );
}

function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    const text = url.toString();
    return text.endsWith("/") ? text.slice(0, -1) : text;
  } catch {
    return input.trim();
  }
}

function clampLimit(k: number): number {
  if (!Number.isFinite(k)) return 10;
  return Math.max(1, Math.min(50, Math.trunc(k)));
}

function compareSavedAtDesc(a: VaultFile, b: VaultFile): number {
  const left = asTrimmedString(a.frontmatter.saved_at);
  const right = asTrimmedString(b.frontmatter.saved_at);
  if (!left && !right) return a.path.localeCompare(b.path);
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
