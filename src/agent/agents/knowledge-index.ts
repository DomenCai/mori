import { OneShotAgent } from "../base.js";
import { buildMemorySnapshot, buildSystemPrompt } from "../prompts.js";
import type { VaultService } from "../../knowledge/vault.js";
import type { MemoryService } from "../../memory/service.js";
import type Database from "better-sqlite3";

export class KnowledgeIndexAgent extends OneShotAgent {
  readonly chatType = "knowledge_index" as const;
  readonly scopeName = "knowledge_index" as const;
  readonly defaultTools = ["read_vault"] as const;

  constructor(
    private readonly vaultService: VaultService,
    private readonly db: Database.Database,
    private readonly memoryService: MemoryService,
  ) {
    super();
  }

  systemPrompt(): () => string {
    return () => {
      this.memoryService.syncEditableMemoryFiles();
      const snapshot = buildMemorySnapshot(this.db, this.memoryService);
      return buildSystemPrompt(snapshot);
    };
  }

  /** 跑完后把 .index.md 写回 vault，返回写入路径。 */
  async run(): Promise<string> {
    const files = this.vaultService
      .listFrontmatter()
      .filter((file) => file.path !== ".index.md")
      .map((file) => ({
        path: file.path,
        frontmatter: file.frontmatter,
      }));

    if (files.length === 0) {
      return this.vaultService.writeKnowledgeIndex("# 知识地图\n\n暂无知识库内容。\n");
    }

    const indexText = await this.runForStream(`# 知识地图 builtin

你的目标是维持一张压缩、可导航的知识地图，如实反映知识库已有内容，让未来的我和 Agent 知道我沉淀了什么、该往哪里挖。

请基于下面每个 vault 文件的 path + frontmatter 生成一份 Markdown 知识地图，直接输出最终 .index.md 正文。

要求：
- 顶层按领域聚类，压缩总结而不是罗列目录。
- 总长度控制在 3000 token 内。
- 可以在必要时调用 read_vault 读取少量文件确认细节，但默认不要读全文。
- 不要修改任何 vault 文件正文。

vault frontmatter:
\`\`\`json
${JSON.stringify(files, null, 2)}
\`\`\``);

    if (!indexText) throw new Error("knowledge_index 未返回正文");
    return this.vaultService.writeKnowledgeIndex(indexText + "\n");
  }
}
