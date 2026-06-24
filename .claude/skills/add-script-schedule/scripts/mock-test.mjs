#!/usr/bin/env node
// 用 fixture JSON 当 fetch 返回，连调脚本 default() 两次，不依赖网络。
// 核对：第一次结构齐全；第二次因去重/state 返回 null。
// 用法： node mock-test.mjs <仓库>/data/script/<name>.mjs <fixture.json>
import { readFileSync } from "node:fs";

const [, , target, fixture] = process.argv;
if (!target || !fixture) {
  console.error("用法： node mock-test.mjs <脚本绝对路径.mjs> <fixture.json>");
  process.exit(1);
}

const data = JSON.parse(readFileSync(fixture, "utf8"));
globalThis.fetch = async () => ({ ok: true, json: async () => data });

const mod = await import(target);
console.log("=== 第一次（应返回完整文章）===");
console.log(JSON.stringify(await mod.default(), null, 2));
console.log("\n=== 第二次（应因去重/state 返回 null）===");
console.log(await mod.default());
