#!/usr/bin/env node
// 全新安装 mori：在仓库根目录装依赖、构建并全局 link，得到 mori 命令。
// 不做 clone（需用户给地址/目录）、不做飞书扫码（需用户手动）—— 这两步由 skill 引导用户完成。
// 用法：
//   node install.mjs                 自动定位本仓库，优先 pnpm
//   node install.mjs <repo-dir>      指定仓库目录
//   node install.mjs --npm           用 npm 兜底（不装 pnpm 时）
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const useNpm = args.includes("--npm");
const repoArg = args.find((a) => !a.startsWith("--"));
// 默认：脚本住在 <repo>/.claude/skills/deploy-mori/scripts/ → 仓库根在上 4 级
const repo = resolve(repoArg || resolve(scriptDir, "..", "..", "..", ".."));

function fail(msg) {
  console.error(`[install] ERROR: ${msg}`);
  process.exit(1);
}
function run(cmd, cmdArgs, opts = {}) {
  console.log(`[install] $ ${cmd} ${cmdArgs.join(" ")}  (cwd=${repo})`);
  const r = spawnSync(cmd, cmdArgs, { cwd: repo, stdio: "inherit" });
  if (r.error) fail(`${cmd} 执行失败：${r.error.message}`);
  if (r.status !== 0) {
    if (opts.hint) console.error(`[install] ${opts.hint}`);
    fail(`${cmd} 退出码 ${r.status}`);
  }
}
function has(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf-8" }).status === 0;
}

// 校验仓库
const pkgPath = join(repo, "package.json");
if (!existsSync(pkgPath) || JSON.parse(readFileSync(pkgPath, "utf-8")).name !== "@domencai/mori") {
  fail(`${repo} 不是 mori 仓库。传入正确目录：node install.mjs <repo-dir>`);
}

// 校验 Node 版本
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 19)) fail(`Node ${process.versions.node} 过低，需 ≥ 22.19`);

// 选包管理器
const pm = useNpm ? "npm" : "pnpm";
if (!has(pm)) {
  if (pm === "pnpm") fail("未找到 pnpm。装：npm i -g pnpm；或改用兜底：node install.mjs --npm");
  fail("未找到 npm。");
}

console.log(`[install] 仓库：${repo}`);
console.log(`[install] 包管理器：${pm}`);

// 装依赖并显式构建
run(pm, ["install"], {
  hint: "若错误是 better-sqlite3 / node-gyp 编译失败，多半缺 Xcode CLT（xcode-select --install）后重试；多数平台会直接下载预编译二进制、无需编译。",
});
run(pm, ["run", "build"]);
// 全局 link
run(pm, pm === "pnpm" ? ["link", "--global"] : ["link"]);

console.log(`
[install] ✓ 安装完成，已得到 mori 命令。接下来（需用户手动）：
  1. mori setup      配置 LLM、选择模型、扫码绑定飞书，并按提示启动
  2. node ${join(scriptDir, "doctor.mjs")} --connectivity   体检（飞书+LLM 连通）
`);
