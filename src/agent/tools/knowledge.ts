import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  FetchArticleParams,
  GrepVaultParams,
  PromoteParams,
  ReadVaultParams,
  SaveToGardenParams,
  UpdateFrontmatterParams,
} from "../schemas.js";
import { fetchArticle, slugify, VaultService } from "../../knowledge/vault.js";
import { nowISO } from "../../utils.js";

export function createKnowledgeTools(vault: VaultService): AgentTool<any>[] {
  return [
    createFetchArticleTool(),
    createSaveToGardenTool(vault),
    createGrepVaultTool(vault),
    createReadVaultTool(vault),
    createUpdateFrontmatterTool(vault),
    createPromoteTool(vault),
  ];
}

function createFetchArticleTool(): AgentTool<typeof FetchArticleParams> {
  return {
    name: "fetch_article",
    label: "抓取文章",
    description: "抓取 URL 文章并清洗成 markdown。当前只支持 URL 文章收藏。",
    parameters: FetchArticleParams,
    execute: async (_id, params) => {
      const article = await fetchArticle(params.url);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(article),
          },
        ],
        details: { title: article.title, source_url: params.url },
      };
    },
  };
}

function createSaveToGardenTool(
  vault: VaultService,
): AgentTool<typeof SaveToGardenParams> {
  return {
    name: "save_to_garden",
    label: "保存到 Garden",
    description:
      "把用户明确要求收藏的知识保存到 vault/Garden。只创建新 markdown 文件，不编辑既有正文。",
    parameters: SaveToGardenParams,
    execute: async (_id, params) => {
      const result = vault.saveToGarden(params, slugify(params.title));
      return {
        content: [
          {
            type: "text",
            text: `已保存到 Garden：${result.path}`,
          },
        ],
        details: result,
      };
    },
  };
}

function createGrepVaultTool(vault: VaultService): AgentTool<typeof GrepVaultParams> {
  return {
    name: "grep_vault",
    label: "检索 Vault",
    description:
      "用 ripgrep 检索 vault。只在当前话题明显可能有沉淀时主动使用，不要把原文整段倒给用户。",
    parameters: GrepVaultParams,
    execute: async (_id, params) => {
      const text = await vault.grep(params.query, params.scope);
      return {
        content: [
          {
            type: "text",
            text: text || "未命中",
          },
        ],
        details: { query: params.query },
      };
    },
  };
}

function createReadVaultTool(vault: VaultService): AgentTool<typeof ReadVaultParams> {
  return {
    name: "read_vault",
    label: "读取 Vault",
    description: "读取一个 vault markdown 文件全文。",
    parameters: ReadVaultParams,
    execute: async (_id, params) => {
      const file = vault.read(params.path);
      return {
        content: [
          {
            type: "text",
            text: `---\n${JSON.stringify(file.frontmatter, null, 2)}\n---\n${file.body}`,
          },
        ],
        details: { path: file.path },
      };
    },
  };
}

function createUpdateFrontmatterTool(
  vault: VaultService,
): AgentTool<typeof UpdateFrontmatterParams> {
  return {
    name: "update_frontmatter",
    label: "更新 Frontmatter",
    description:
      "只更新 vault 文件 frontmatter，不修改正文。fields 必须通过 frontmatter_json 传 JSON 对象字符串。",
    parameters: UpdateFrontmatterParams,
    execute: async (_id, params) => {
      const fields = JSON.parse(params.frontmatter_json) as Record<string, any>;
      vault.updateFrontmatter(params.path, fields);
      return {
        content: [
          {
            type: "text",
            text: `已更新 frontmatter：${params.path}`,
          },
        ],
        details: { path: params.path, fields },
      };
    },
  };
}

function createPromoteTool(vault: VaultService): AgentTool<typeof PromoteParams> {
  return {
    name: "promote",
    label: "晋升知识",
    description:
      "把 Inbox 文件移动到 Garden，并只更新 frontmatter。不会修改正文。",
    parameters: PromoteParams,
    execute: async (_id, params) => {
      const nextPath = vault.promote(params.path, {
        my_note: params.my_note,
        reacted_at: nowISO(),
      });
      return {
        content: [
          {
            type: "text",
            text: `已晋升到 Garden：${nextPath}`,
          },
        ],
        details: { path: nextPath },
      };
    },
  };
}
