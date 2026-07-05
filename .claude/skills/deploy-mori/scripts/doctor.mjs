#!/usr/bin/env node
// mori 体检：运行环境、安装状态、~/.mori 配置、daemon 状态，可选飞书 + LLM 真实连通测试。
// 用法：
//   node doctor.mjs                  仅本地检查（不联网、不花 token）
//   node doctor.mjs --connectivity   额外做飞书 tenant_access_token + LLM 最小请求连通测试
//                                    （anthropic-messages / openai-completions / openai-responses 三种 api 都覆盖）
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.argv.includes("--connectivity");
const HOME = join(homedir(), ".mori");
const scriptDir = dirname(fileURLToPath(import.meta.url));
// 这个脚本住在 <repo>/.claude/skills/deploy-mori/scripts/ —— 仓库根在上 4 级
const selfRepo = resolve(scriptDir, "..", "..", "..", "..");

function sh(cmd) {
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}
function parseEnv(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const mark = { ok: "✓", bad: "✗", warn: "⚠", info: "·", skip: "?" };
function line(sym, msg) {
  console.log(`  ${mark[sym]} ${msg}`);
}
function section(title) {
  console.log(`\n${title}`);
}

// ── 运行环境 ──────────────────────────────────────────────
section("运行环境");
{
  const [maj, min] = process.versions.node.split(".").map(Number);
  const okNode = maj > 22 || (maj === 22 && min >= 19);
  line(okNode ? "ok" : "bad", `Node ${process.versions.node}${okNode ? "" : "（需 ≥ 22.19）"}`);
  const pnpm = sh("command -v pnpm && pnpm -v");
  line(pnpm.ok ? "ok" : "warn", pnpm.ok ? `pnpm ${pnpm.out.split("\n").pop()}` : "pnpm 缺失（推荐 npm i -g pnpm，或用 npm 兜底）");
  const npm = sh("command -v npm && npm -v");
  line(npm.ok ? "info" : "warn", npm.ok ? `npm ${npm.out.split("\n").pop()}` : "npm 也缺失");
  if (process.platform === "darwin") {
    const clt = sh("xcode-select -p");
    line(clt.ok ? "ok" : "info", clt.ok
      ? "Xcode CLT 已装（native 编译兜底就绪）"
      : "未装 Xcode CLT —— 仅当 better-sqlite3 拿不到预编译二进制、需本地编译时才需要（少见）");
  }
}

// ── 文章抓取依赖 ──────────────────────────────────────────
section("文章抓取依赖");
{
  const defuddle = sh("command -v defuddle && defuddle --version 2>/dev/null || true");
  if (defuddle.out) {
    const version = defuddle.out.split("\n").pop();
    line("ok", `defuddle 已安装${version && version !== defuddle.out.split("\n")[0] ? `（${version}）` : ""}`);
  } else {
    line("warn", "defuddle 未安装；fetch_article 会临时走 npx defuddle，首次抓取可能很慢或超时。先询问用户，再用 pnpm add -g defuddle 安装");
  }
}

// ── mori 安装 ─────────────────────────────────────────────
section("mori 安装");
let installed = false;
let linkedRepo = "";
{
  const bin = sh("command -v mori");
  installed = bin.ok;
  if (!installed) {
    line("bad", "mori 未安装（不在 PATH）→ 走全新安装：node install.mjs");
  } else {
    const ver = sh("mori -v");
    line("ok", `已安装，版本 ${ver.ok ? ver.out : "未知"}`);
    try {
      const real = realpathSync(bin.out);
      // 形如 <repo>/dist/main.js → 源码 link 部署
      const maybeRepo = resolve(dirname(real), "..");
      if (existsSync(join(maybeRepo, "package.json")) && readJson(join(maybeRepo, "package.json")).name === "@domencai/mori") {
        linkedRepo = maybeRepo;
        line("info", `源码部署，仓库：${linkedRepo}`);
      } else {
        line("info", `bin 指向 ${real}（疑似全局包部署，升级走重装）`);
      }
    } catch {}
  }
}

// ── 源码仓库 ──────────────────────────────────────────────
section("源码仓库");
{
  const repo = linkedRepo || (existsSync(join(selfRepo, "package.json")) ? selfRepo : "");
  if (!repo) {
    line("warn", "未定位到源码仓库（skill 可能被单独取用）→ 安装前需先 clone");
  } else {
    const head = sh(`git -C "${repo}" rev-parse --short HEAD`);
    const ver = existsSync(join(repo, "package.json")) ? readJson(join(repo, "package.json")).version : "?";
    line("ok", `${repo}（源码版本 ${ver}${head.ok ? `, HEAD ${head.out}` : ""}）`);
    line("info", "升级：node update.mjs（在本脚本同目录）");
  }
}

// ── ~/.mori 配置 ──────────────────────────────────────────
section("~/.mori 配置");
let larkCfg = null;
let setting = null;
{
  if (!existsSync(HOME)) {
    line("bad", "~/.mori 不存在（从未配置）→ 首次需 mori setup");
  } else {
    const larkPath = join(HOME, "lark_config.json");
    if (existsSync(larkPath)) {
      larkCfg = readJson(larkPath);
      line("ok", `飞书已注册（tenant=${larkCfg.tenant ?? "feishu"}${larkCfg.ownerOpenId ? ", owner 已绑定" : ", owner 未绑定"}）`);
    } else {
      line("bad", "lark_config.json 缺失 → mori setup 扫码注册");
    }
    const settingPath = join(HOME, "setting.json");
    if (existsSync(settingPath)) {
      setting = readJson(settingPath);
      line("ok", "setting.json 存在");
      const env = parseEnv(join(HOME, ".env"));
      const keys = new Set(Object.values(setting.llm?.providers ?? {}).map((p) => p.apiKeyEnv).filter(Boolean));
      if (setting.knowledge?.search?.apiKeyEnv) keys.add(setting.knowledge.search.apiKeyEnv);
      for (const k of keys) line(env[k] ? "ok" : "bad", env[k] ? `.env ${k} 已填` : `.env 缺 ${k}`);
    } else {
      line("warn", "setting.json 缺失（首次 mori run 会从模板生成）");
    }
  }
}

// ── daemon 状态 ───────────────────────────────────────────
section("daemon 状态");
if (installed) {
  const st = sh("mori status");
  console.log((st.out || st.err).split("\n").map((l) => "  " + l).join("\n"));
  if (/启动版本/.test(st.out) && /当前产物版本/.test(st.out)) {
    line("warn", "daemon 跑的是旧产物，建议 mori stop && mori start");
  }
} else {
  line("skip", "mori 未安装，跳过");
}

// ── 连通测试（--connectivity）────────────────────────────
if (LIVE) {
  section("连通测试");
  if (larkCfg?.appId && larkCfg?.appSecret) {
    const url = (larkCfg.domain || "https://open.feishu.cn") + "/open-apis/auth/v3/tenant_access_token/internal";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: larkCfg.appId, app_secret: larkCfg.appSecret }),
      });
      const j = await r.json();
      line(j.code === 0 ? "ok" : "bad", j.code === 0 ? "飞书凭据有效" : `飞书鉴权失败 code=${j.code} ${j.msg}`);
    } catch (e) {
      line("bad", `飞书请求异常：${e.message}`);
    }
  } else {
    line("skip", "无飞书凭据，跳过飞书连通");
  }

  if (setting?.llm?.providers) {
    const env = parseEnv(join(HOME, ".env"));
    for (const [name, prov] of Object.entries(setting.llm.providers)) {
      const key = env[prov.apiKeyEnv];
      if (!key) {
        line("bad", `${name}: .env ${prov.apiKeyEnv} 为空`);
        continue;
      }
      const model = Object.keys(prov.models ?? {})[0];
      const base = prov.baseUrl.replace(/\/$/, "");
      try {
        let r;
        if (prov.api === "anthropic-messages") {
          r = await fetch(base + "/v1/messages", {
            method: "POST",
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          });
        } else if (prov.api === "openai-completions") {
          r = await fetch(base + "/chat/completions", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          });
        } else if (prov.api === "openai-responses") {
          r = await fetch(base + "/responses", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ model, input: "hi", max_output_tokens: 16 }),
          });
        } else {
          line("skip", `${name}: api=${prov.api}，未内置自动测试，请手动确认 baseUrl/key`);
          continue;
        }
        line(r.ok ? "ok" : "bad", r.ok ? `${name} (${model}) 连通` : `${name}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      } catch (e) {
        line("bad", `${name}: ${e.message}`);
      }
    }
  } else {
    line("skip", "无 setting.json，跳过 LLM 连通");
  }
} else {
  console.log("\n（加 --connectivity 可做飞书 + LLM 真实连通测试）");
}

console.log("");
