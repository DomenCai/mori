import { OneShotAgent } from "../base.js";
import { buildMemorySnapshot, buildSystemPrompt } from "../prompts.js";
import type { MemoryService } from "../../memory/service.js";
import type Database from "better-sqlite3";

export interface WeeklyReviewInput {
  weekItems: Array<{
    path: string;
    title: string;
    source_type: string;
    excerpt: string;
  }>;
  priorReviews: Array<{ period: string; body: string }>;
  period: string;
}

export class WeeklyReviewAgent extends OneShotAgent {
  readonly chatType = "review" as const;
  readonly scopeName = "weekly_review" as const;
  readonly defaultTools = ["vault_read"] as const;

  constructor(
    private readonly input: WeeklyReviewInput,
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

  async run(): Promise<string | null> {
    const text = await this.runForFinalText(buildWeeklyReviewPrompt(this.input));
    return text.trim() || null;
  }
}

function buildWeeklyReviewPrompt(input: WeeklyReviewInput): string {
  return `你在为用户生成过去这一周（${input.period}）的收藏周报，目的是把他这一周收藏却可能再没打开的东西，重新带回他面前。

## 这一周新增（title + 摘录）

${JSON.stringify(input.weekItems, null, 2)}

## 最近几期周报（用于承接，不要重复其内容）

${JSON.stringify(input.priorReviews, null, 2)}

## 要求

1. 不要做成清单。清单是又一个他不会读的东西。要主题化、有重点、有脉络。
2. 找出这一周的主线，把同主题的几条串起来讲清楚它们的关系和分歧。
3. 零散的一两条单独点一句即可。
4. 若与最近几期有延续，明确承接。
5. 自然口吻，像一个了解他的人在帮他回顾，不堆术语、不写“本周共收藏 N 篇”的报告腔。
6. 需要某条细节时可调 vault_read 读全文。

直接输出周报正文 markdown，不要输出任何额外说明。`;
}
