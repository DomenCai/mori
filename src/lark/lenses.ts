export type LensKind = "think" | "rank" | "plain";

export interface ParsedLens {
  lens: LensKind;
  body: string;
}

export function parseLens(content: string): ParsedLens | null {
  const match = content.trim().match(/^\/(think|rank|plain)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    lens: match[1] as LensKind,
    body: (match[2] ?? "").trim(),
  };
}

export function formatLensPrompt(lens: LensKind, target: string): string {
  return `${lensInstruction(lens)}

对象：
${target}`;
}

function lensInstruction(lens: LensKind): string {
  switch (lens) {
    case "think":
      return `把下面这件事往下钻，别往旁边扯。

- 每往下一层只回答「为什么会这样」，不是「还有什么」。
- 每层尽量换一个更底层的框架看：社会层底下是心理层，心理层底下是生物或物理层，再底下是逻辑本身。具体怎么换看题目。
- 钻到一层，顺手点出这层里那个还没解决的矛盾，那就是往下一层的入口。
- 钻到再问「为什么」只剩同义反复，或者撞上人性的硬结构、物理定律、逻辑本身、一个绕不开的悖论，就到底了。浅的三层，深的六七层，自己判断。`;
    case "rank":
      return `把下面这个东西降秩，砍到背后真正独立、互不能推导的两三根生成器。

- 不要把现象重新分组，也不要列知识点清单；找能生成这些现象的底层线。
- 每根生成器都要说明它单独解释了什么，和其他生成器为什么不能互相替代。
- 用这几根线反推回原来的混乱表面，看能不能解释大部分重要现象。
- 用好解释的标准检查：动一根就会塌的是好骨架，怎么改都还能用的是坏解释。
- 最后给出一个可记住的世界观，而不是资料目录。`;
    case "plain":
      return `把下面这个东西讲到聪明的十二岁小孩能复述。

- 不产出新主张，只换说法；先把术语拆成普通人每天会碰到的事。
- 一句只讲一件事，能用短词不用长词，能用具体的人和具体场景就别用抽象名词。
- 优先用类比、画面和小故事，但类比只负责照亮，不要拿类比偷换证明。
- 如果对象里有 URL，先用 fetch_article；如果解释依赖你不确定或可能过期的事实，先用 web_search。
- 讲完后点出最容易误解的裂缝，让读者知道自己真懂了什么、还没懂什么。`;
  }
}
