import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LarkChannel } from "@larksuite/channel";
import {
  FetchArticleParams,
  VaultReadParams,
  VaultSaveParams,
  VaultSearchParams,
} from "../schemas.js";
import { VaultService } from "../../knowledge/vault.js";
import { fetchArticle } from "../../knowledge/fetch.js";
import { createWebSearchTool, isWebSearchConfigured } from "./web-search.js";

export function createKnowledgeTools(
  vault: VaultService,
  channel?: LarkChannel,
): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    createFetchArticleTool(channel),
    createVaultSaveTool(vault),
    createVaultSearchTool(vault),
    createVaultReadTool(vault),
  ];
  if (isWebSearchConfigured()) {
    tools.unshift(createWebSearchTool());
  }
  return tools;
}

function createFetchArticleTool(channel?: LarkChannel): AgentTool<typeof FetchArticleParams> {
  return {
    name: "fetch_article",
    label: "抓取文章",
    description:
      "抓取 URL 并清洗成 markdown。抓到内容后仅当用户明确要求收藏时才调 vault_save，否则只用于阅读和回答。",
    parameters: FetchArticleParams,
    execute: async (_id, params) => {
      const article = await fetchArticle(params.url, channel?.rawClient);
      return {
        content: [{ type: "text", text: JSON.stringify(article) }],
        details: article,
      };
    },
  };
}

function createVaultSaveTool(vault: VaultService): AgentTool<typeof VaultSaveParams> {
  return {
    name: "vault_save",
    label: "保存 Vault",
    description:
      "把用户明确要求收藏的内容新增保存到 vault。不能覆盖既有文件，不能写 review/conversation。",
    parameters: VaultSaveParams,
    execute: async (_id, params) => {
      const result = vault.ingestNote(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

function createVaultSearchTool(vault: VaultService): AgentTool<typeof VaultSearchParams> {
  return {
    name: "vault_search",
    label: "检索 Vault",
    description:
      "用 ripgrep 检索 vault；query 为空时返回最近笔记。搜到多条相关内容时应读相关文件并综合。",
    parameters: VaultSearchParams,
    execute: async (_id, params) => {
      const results = await vault.search(params.query, params.k ?? 10);
      return {
        content: [
          {
            type: "text",
            text: results.length ? JSON.stringify(results, null, 2) : "[]",
          },
        ],
        details: { query: params.query, count: results.length },
      };
    },
  };
}

function createVaultReadTool(vault: VaultService): AgentTool<typeof VaultReadParams> {
  return {
    name: "vault_read",
    label: "读取 Vault",
    description: "读取一个 vault markdown 文件全文。",
    parameters: VaultReadParams,
    execute: async (_id, params) => {
      const file = vault.read(params.path);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(file, null, 2),
          },
        ],
        details: { path: file.path },
      };
    },
  };
}
