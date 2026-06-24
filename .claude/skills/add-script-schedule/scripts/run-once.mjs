#!/usr/bin/env node
// 真实网络跑一次脚本的 default()，打印返回的文章或 null，
// 用于确认接口字段名与脚本一致。会写出脚本的 .*-state.json，测完记得删。
// 用法： node run-once.mjs <仓库>/data/script/<name>.mjs
const target = process.argv[2];
if (!target) {
  console.error("用法： node run-once.mjs <脚本绝对路径.mjs>");
  process.exit(1);
}
const mod = await import(target);
const r = await mod.default();
console.log(
  r === null ? "→ return null（无新增/无内容，框架会跳过，不写文件不推卡片）" : JSON.stringify(r, null, 2),
);
