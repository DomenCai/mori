---
name: deploy-mori
description: 部署 / 安装 / 升级 mori 个人 agent，并体检配置。当用户说"部署这个项目"、"帮我装一下 mori"、"我刚拉了代码怎么跑起来"、"升级到最新版"、"检查配置对不对"、"mori 起不来"、"绑定飞书"，或把这个 skill 链接丢给某个 agent 要求从零把 mori 跑起来时触发。覆盖三类场景：全新安装（clone + pnpm link + 引导飞书扫码）、源码升级（update.mjs）、配置体检（文件 / key / 飞书 & LLM 真实连通测试）。
---

# 部署 mori

mori 是 Node 22+ TypeScript ESM 的飞书个人 agent，常驻后台运行。本 skill 把"在这台机器上把 mori 跑起来并保持最新"从全新安装做到升级与配置体检。

执行逻辑都在同目录 `scripts/` 里，**优先调脚本、别在对话里手敲等价命令**：

- `scripts/doctor.mjs` — 体检与探测：运行环境、安装状态、源码仓库、`~/.mori` 配置、daemon 状态；加 `--connectivity` 再做飞书 + LLM 真实连通测试。
- `scripts/install.mjs` — 全新安装：在仓库根装依赖（`prepare` 钩子自动 build）并全局 link。
- `scripts/update.mjs` — 源码部署自更新：`git pull` → 必要时重建 → 补全/迁移 `setting.json` → 按需重启 daemon。

## 部署形态与数据位置

主推 **源码 checkout + 全局 link**：clone 仓库 → link 出 `mori` 命令 → 升级走 `update.mjs`。运行数据全在 `~/.mori/`（`lark_config.json` 飞书凭据、`setting.json` LLM/会话配置、`.env` API key、`memory/`、`app.db`、`sessions/`、`logs/`）。版本看 `mori -v`。

前置依赖：**Node ≥ 22.19**、**pnpm**（缺失推荐 `npm i -g pnpm`，也可用 npm 兜底）。`better-sqlite3` 默认下载预编译二进制，**通常不需要编译器**；仅当拿不到匹配二进制需本地编译时（全新 Node 大版本 / 冷门平台 / GitHub 下载受阻）才需 macOS 的 **Xcode CLT**。

⚠️ **飞书扫码注册必须用户前台手动完成**（`mori run` 在终端渲染二维码），脚本无法代劳，只能引导。所有有副作用的动作（clone、装包、link、拉起 daemon、连通测试发真实请求）**先问用户再做**。

## 第 0 步：体检定位，再分流

```bash
node <skill>/scripts/doctor.mjs
```

`<skill>` 是本 skill 目录（脚本会从自身位置往上 4 级找仓库根）。读它的输出判断分流：

- **「mori 未安装」** → **场景 A · 全新安装**。
- **已安装** → **场景 B · 升级**，升级后接体检。
- **想单独查配置对不对** → **场景 C · 配置体检**。
- **「未定位到源码仓库」**（只取了 skill、没有仓库）→ 先按 A2 clone。

---

## 场景 A · 全新安装

1. **补依赖**：doctor 报 Node 过低 / 缺 pnpm / 缺 Xcode CLT 时，告知用户处理（升级 Node、`npm i -g pnpm`、`xcode-select --install`），不擅自改全局环境。
2. **拿代码**：已在 mori 仓库里（doctor 报出源码仓库）直接用；只取了 skill 则**问用户** clone 到哪、仓库地址（private 仓库，用户知道自己的 fork），再 `git clone <地址> <目录>`。
3. **装 + link**：
   ```bash
   node <skill>/scripts/install.mjs            # 自动定位本仓库，优先 pnpm
   node <skill>/scripts/install.mjs <repo-dir> # 指定仓库目录（如刚 clone 的位置）
   node <skill>/scripts/install.mjs --npm      # 用户不装 pnpm 时兜底
   ```
   装完得到 `mori` 命令，脚本会打印后续手动步骤。
4. **引导飞书绑定**（用户手动）：① `mori run` → 扫码注册 → `Ctrl+C` 退出；② 编辑 `~/.mori/.env` 填各 `apiKeyEnv`（至少 `ANTHROPIC_API_KEY`，用知识检索还要 `TAVILY_API_KEY`）；③ `mori start`。
5. **体检**：跑场景 C 确认真实可用。

---

## 场景 B · 升级

```bash
node <skill>/scripts/update.mjs
```

`update.mjs` 自动定位仓库根（git toplevel），校验是 git 分支（拒绝 dev / detached HEAD），`git pull --rebase --autostash`，按"有新 commit / 产物 commit 不一致 / 版本不一致 / 有本地 tracked 改动 / node_modules 缺失"任一原因决定是否重建（`pnpm install --frozen-lockfile` + `pnpm build`），进程内补全/迁移 `setting.json` 字段，**仅当原本在运行时**重启 daemon。已是最新直接报"无需更新"。把它的输出（更新原因、`X -> Y` 版本变化）转述给用户，然后跑场景 C 体检。

**非源码部署**（doctor 报 bin 指向不是 mori 仓库，即 `pnpm add -g github:...` 全局包）→ update.mjs 不适用，改重装：**问用户**地址后 `pnpm add -g github:<owner>/mori`，再 `mori stop && mori start`。

---

## 场景 C · 配置体检

```bash
node <skill>/scripts/doctor.mjs --connectivity
```

除文件/key 存在性，额外做飞书 `tenant_access_token`（免费、不发消息）和 LLM `max_tokens:1` 最小请求连通测试（消耗可忽略）。据输出处理：

- 某 key 缺失 → 告诉用户缺哪个、填到 `~/.mori/.env` 哪个变量名，填完重测。
- 飞书/LLM 连通失败 → 报具体 HTTP/错误码给用户排查。
- 配置齐全但 daemon 未运行 → **问用户**是否 `mori start`。
- doctor 提示「daemon 跑的是旧产物」→ `mori stop && mori start`。

---

## 排查
- **mori 命令找不到**：link 后 pnpm 全局 bin 不在 PATH → `pnpm config get global-bin-dir`，加进 shell PATH。
- **`better-sqlite3` 安装报错**：预编译二进制没下到、回退本地编译又缺 Xcode CLT（`xcode-select --install`）；或 Node 版本没有对应 prebuild。
- **daemon 起不来**：多半 `lark_config.json` 缺失（没扫码）或 LLM key 没填 → 看 `~/.mori/logs/$(date +%F).log`。
- **update.mjs 报「不在 git 工作副本 / detached HEAD / dev 模式」**：它只服务源码 link 部署；全局包部署走场景 B 的重装路径。
