---
name: add-script-schedule
description: 为 mori 新增一个自定义 script 定时任务（定时抓取外部源 → 生成知识文章 → 投递 Inbox/飞书）。当用户说"加个定时任务"、"定时抓取/拉取某接口"、"每隔 N 小时跑一个脚本"、"做个定时投喂"、"加个 script 调度"，或要把已写好的抓取脚本接入定时投递时触发。覆盖从写脚本、本地测试到复制进生产目录 ~/.mori/ 并重启守护进程的完整流程。
---

# 新增 mori script 定时任务

mori 的 `script` 调度专为「定时抓外部源 → 生成一篇知识文章 → 落 Inbox 并可选推飞书」设计。新增一个这样的任务 = 写一个 `.mjs` 脚本 + 在 `schedules.json` 加一条配置，无需改 mori 框架代码。本 skill 负责把这件事从开发做到上线。

## 机制速览

croner 按 cron 触发 → 在 worker 线程里 `import` 脚本 → 调用其 `default export` 的 async 函数 → 拿到返回的 `KnowledgeArticle` → `vault.writeInbox` 落到 `Inbox/<inbox>/<月份>/<slug>.md` → 若 `deliver.notify` 为 true 则渲染飞书卡片推到通知群并记一条消息。

路径随环境切换:**开发(`pnpm dev`,设了 `MORI_DEV=1`)读项目内 `./data/`;生产读 `~/.mori/`**。脚本放 `<ROOT>/script/`,调度配置在 `<ROOT>/schedules.json`。

## 脚本契约

`<ROOT>/script/<name>.mjs` 必须 `default export` 一个 async 函数,返回 `KnowledgeArticle` 或 `null`:

```js
export default async function () {
  // ...抓取、处理...
  if (没有新内容) return null;       // 框架静默跳过：不写文件、不推卡片
  return {
    title: "...",        // 必填
    domain: "...",       // 必填，领域标签
    brief: "...",        // 必填，一句话摘要
    body: "...",         // 必填，markdown 正文
    tags: ["...", ...],  // 可选
    source_url: "...",   // 可选
  };
}
```

要点:
- 运行在 worker 线程,Node 22 全局 `fetch` 可用,超时用 `AbortSignal.timeout(ms)`。
- 需要跨窗口去重/记状态时,在脚本同目录用 `join(import.meta.dirname, ".xxx-state.json")` 自存自取(`import.meta.dirname` 即 `<ROOT>/script`,开发生产都对)。已有范例:`aihot-selected.mjs` 用 `.aihot-state.json` 存上次最大 `publishedAt` 做增量。
- 抛错会被记成 error 日志且不投递;「本窗口无新增」要用 `return null`,别抛错。
- 去重 slug 按分钟级运行窗口生成,正常 cron 周期不会误判重复。

## 调度配置

往 `schedules.json` 的 `schedules` 数组加一条(只需写 script 任务自己的字段,builtin 默认任务由代码兜底):

```json
{
  "id": "<唯一-id>",
  "name": "<显示名>",
  "kind": "script",
  "script": "<name>.mjs",
  "cron": "0 */2 * * *",
  "deliver": { "notify": true, "inbox": "<Inbox 子目录名>" },
  "enabled": true
}
```

`runtime` 可选,覆盖 `{ timeoutMs, resourceLimits }`,不写走 `setting.json` 的 `script.defaults`。

## 操作流程

> 下文 `$SKILL` = 本 skill 所在目录的绝对路径（即本文件所在目录）。其 `scripts/` 下放好了可复用 helper，**直接带参数跑，不要再手写一次性脚本**：
> - `merge-schedule.mjs` —— 幂等合并一条调度进 `schedules.json`
> - `detect-env.sh` —— 探测守护进程状态（A/B/C）
> - `mock-test.mjs` / `run-once.mjs` —— mock / 真实网络各跑一次脚本

### 1. 写脚本并在开发环境配置
- 把 `.mjs` 写到 `./data/script/`。写接口对接前，先用 `curl`（或你所在 agent 的联网/抓取工具）确认真实 JSON 字段名，别照文档臆测。
- 调度条目用 helper 合并进开发配置（`--file` 指向开发的 `./data/schedules.json`）：
  ```bash
  node $SKILL/scripts/merge-schedule.mjs --id <id> --name "<显示名>" \
    --script <name>.mjs --cron "<cron>" --inbox "<Inbox名>" --file ./data/schedules.json
  ```

### 2. 本地测试（必做，上线前）
- **mock 测试**（不依赖网络）：造一个 fixture JSON（贴接口真实返回，或复制 `data/script/*.json` 样本），跑：
  ```bash
  node $SKILL/scripts/mock-test.mjs <仓库>/data/script/<name>.mjs <fixture.json>
  ```
  核对：第一次结构齐全、第二次因去重/state 返回 `null`。
- **真实网络跑一次**（确认字段名一致）：
  ```bash
  node $SKILL/scripts/run-once.mjs <仓库>/data/script/<name>.mjs
  ```
- 两种测试都会让脚本写出 `.*-state.json`，测完删掉脚本目录里的它，避免把锚点带上线。

### 3. 探测生产环境状态（动手上线前先判断）
上线 = 把脚本和调度放进生产目录 `~/.mori/` 并让**运行中的**守护进程注册它。生产 `~/.mori/` 与开发 `./data/` 是两套独立文件。动手前先探明环境处于哪种状态:

```bash
bash $SKILL/scripts/detect-env.sh <仓库>
```

输出含解析出的 `LAUNCH`（后续 `$LAUNCH` 即指它）和 `STATE`：

- **状态 A · 未安装**（`STATE=A_not_installed`）:`mori` 不在 PATH 且没有 `dist/main.js`(没 build、没装全局,或只在 dev 跑过)。
- **状态 B · 已安装未运行**（`STATE=B_stopped`）:有启动命令,`status` 报「未运行」。
- **状态 C · 运行中**（`STATE=C_running`）:`status` 显示 pid。

A 和 B 都**先问用户、不擅自动手**(拉起后台进程 / 全局装包都是有副作用的动作)。注意:能 `node <仓库>/dist/main.js status` 跑通就属于 B 而非 A——别因为 `mori` 不在 PATH 就误判成未安装。

纯 dev 用户(只用 `pnpm dev` 在 `./data/` 跑)不走下面的生产上线:配置已写进 `./data/` 即可,让用户 `Ctrl+C` 重启一次 `pnpm dev` 即生效(croner 只在启动时注册)。

### 4. 按状态上线
复制脚本 + 幂等合并配置是 B/C 必做、A 装完也做的公共动作,命令在本步末尾。先按状态决定要不要做、以及怎么让任务生效:

**状态 C · 运行中** — 复制 + 合并 + 重启:
```bash
$LAUNCH stop && $LAUNCH start
$LAUNCH status        # 确认已重新拉起
```
**新增 schedule 必须重启**:croner 在守护启动时一次性注册,不重启不生效(仅切 `enabled` 是热生效,新增不是)。若只改已存在脚本的 `.mjs` 内容,则无需重启。改过框架 TS 代码要先 `pnpm build`(只改 `.mjs`/`.json` 不用)。

**状态 B · 已安装未运行** — 先做复制 + 合并,然后**问用户**「检测到 mori 已安装但没在运行,要现在帮你启动吗?」:
- 要 → `$LAUNCH start && $LAUNCH status`。
- 不要 → 告知配置已就位,下次用户自己 `mori start` 时自动注册生效。

**状态 A · 未安装** — 装 mori 不归本 skill 管，交给 `deploy-mori` skill（或直接跑它的 `scripts/install.mjs`）。**问用户**「还没装 mori，要现在帮你装吗?」：
- 不要 → 脚本和配置就留在开发目录 `./data/`，告知装好后再回来上线。
- 要 → 走 `deploy-mori`（全新安装 + 飞书扫码注册都在那里），装好得到 `mori` 命令、守护进程能起来后，再回到本步做下面的复制 + 合并。

复制脚本 + 幂等合并配置(B/C / A 装完都要做):
```bash
mkdir -p ~/.mori/script
cp ./data/script/<name>.mjs ~/.mori/script/
node $SKILL/scripts/merge-schedule.mjs --id <id> --name "<显示名>" \
  --script <name>.mjs --cron "<cron>" --inbox "<Inbox名>"   # 不带 --file，默认写 ~/.mori/schedules.json
```

### 5. 收尾
- 删除测试产生的临时文件和 state。
- 告知用户:任务已上线,下次 cron 命中即触发;想立即验证可在飞书通知群等待或临时把 cron 调近测一次后改回。

## 排查
- 没收到卡片:看 `~/.mori/logs/` 当天日志里 `cron`/script 相关行;确认 `enabled:true`、`deliver.notify:true`、通知群已绑定(`ownerOpenId`)。
- 一直"无投递":多半是 state 锚点已是最新或脚本 `return null`,属正常;想强制重推删掉对应 `.*-state.json`。
- 报错"script 不存在":脚本没复制到 `~/.mori/script/`,或 `script` 字段名对不上。
