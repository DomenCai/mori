#!/usr/bin/env node
// 真实网络跑一次脚本的 default()。script schedule 会打印返回结果；
// agent task script 会打印 task spec 摘要。会写出脚本的 .*-state.json，测完记得删。
// 用法： node run-once.mjs <仓库>/data/script/<name>.mjs
import { Type } from "@earendil-works/pi-ai";

const target = process.argv[2];
if (!target) {
  console.error("用法： node run-once.mjs <脚本绝对路径.mjs>");
  process.exit(1);
}
const mod = await import(target);
const r = await mod.default({ Type });
if (r && typeof r === "object" && typeof r.prompt === "string") {
  console.log(JSON.stringify({
    prompt: r.prompt.slice(0, 300),
    system: r.system ?? "bare",
    tools: Array.isArray(r.tools)
      ? r.tools.map((tool) => typeof tool === "string" ? tool : tool.name)
      : [],
    hasResult: typeof r.result === "function",
  }, null, 2));
  process.exit(0);
}
console.log(
  r === null ? "→ return null（无新增/无内容，框架会跳过，不写文件不推卡片）" : JSON.stringify(r, null, 2),
);
