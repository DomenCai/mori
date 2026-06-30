# CLI 使用指南

把 mori 作为常驻 CLI 安装、守护运行。本地开发见 [开发指南](development.md)。

## 安装

需要 Node ≥ 22.19、pnpm。`better-sqlite3` 默认下载预编译二进制，通常无需编译器；只有拿不到匹配 prebuild 需本地编译时（全新 Node 大版本 / 冷门平台 / GitHub 下载受阻）才需要 macOS 的 Xcode Command Line Tools。安装过程中 `prepare` 脚本会自动跑 `tsc` 编译，无需提前 build。

**从 GitHub 安装**（仓库含飞书 secret / LLM key，通常是 private，走你本机的 git 凭据）：

```bash
pnpm add -g github:DomenCai/mori          # 替换为你的仓库
pnpm add -g github:DomenCai/mori#v1.0.0    # 指定 tag/commit
```

**从本地安装**：

```bash
cd /path/to/mori
pnpm add -g $(pwd)        # 安装当前目录
# 或开发期软链，改完即生效：
pnpm link --global
```

装好后获得 `mori` 命令。

## 首次配置

后台守护无法扫码，**首次必须前台跑一次**完成飞书注册：

```bash
mori run
```

终端渲染二维码，用飞书 App 扫码创建/授权应用，凭据写入 `~/.mori/lark_config.json`。完成后 `Ctrl+C` 退出。

再配置 LLM key：编辑 `~/.mori/.env`，填 `~/.mori/setting.json` 里 `apiKeyEnv` 对应的 key。`setting.json` 首次缺失时会从仓库默认模板自动生成。

## 守护运行

```bash
mori start     # 后台 detached 启动，写 pid，日志重定向到文件
mori status    # 是否在运行 + pid + 运行中版本 + 日志路径
mori stop      # 停止
mori run       # 前台运行（调试 / 首次扫码用）
mori -v        # 当前产物版本
```

`-v` 显示当前命令会运行的编译产物版本，来自 build 时写入的 `dist/build-info.json`。`status` 显示 daemon 启动时冻结进 pid 的启动版本；如果当前产物已经 rebuild 但 daemon 还没重启，`status` 会同时显示“启动版本”和“当前产物版本”。版本不读源码 `package.json`，裸 `git pull` 不影响，只有重新 build 才会变。

`start` 会先检查是否已在运行、飞书是否已配置，再 fork 后台进程。pid 文件由 `start` 写、`stop` 删，并记录进程启动时间和脚本路径；`stop/status` 会先校验进程归属，进程异常退出或 PID 复用后的残留 pid 会被识别和清理。旧格式 pid 文件若对应进程仍存活，会拒绝自动停止，避免误杀无关进程。

## 记忆修改

飞书斜杠命令只支持查看。需要显式修改慢变量或 storyline 状态时，用 CLI：

```bash
mori profile add "新的画像文本"
mori profile remove "要删除的唯一子串"
mori profile replace "旧文本" -- "新文本"
mori storyline close <id>
mori storyline reopen <id>
```

`profile replace` 用 `--` 分隔新旧文本。画像修改会同步写入 SQLite 和 `~/.mori/memory/profile.md`；storyline 状态修改会写入 SQLite 并记录 revision。

## 文件位置

全部在 `~/.mori/` 下：

| 路径 | 内容 |
|---|---|
| `lark_config.json` | 飞书凭据、owner、chat 绑定 |
| `setting.json` | LLM、时区、会话、HTTP、script 和知识搜索配置 |
| `.env` | LLM API key |
| `agent/` | 用户 prompt override、说明，以及只读参考用的 `builtin/` |
| `memory/` | 可编辑的身份画像 `profile.md` 和当前主线 `chapter.md` |
| `app.db` | SQLite 数据库 |
| `sessions/` | 会话状态，JSONL 文件按业务时区命名 |
| `logs/YYYY-MM-DD.log` | 运行日志，按业务时区切分 |
| `agent.pid` | 运行中进程的 pid |

## 日志

运行时 stdout/stderr 会按 `setting.time.timezone` 写入 `~/.mori/logs/YYYY-MM-DD.log`。前台 `run` 会同时保留终端输出；后台 `start` 只写日志文件。

```bash
tail -f ~/.mori/logs/$(date +%F).log
LOG_LEVEL=debug mori run   # 临时调高日志级别
```

## 升级

**源码 checkout / link 部署**（当前安装目录本身就是本地 git 工作副本）跑自更新脚本升级。脚本随仓库分发在 deploy-mori skill 下，会自动定位仓库根，在任意目录都能调：

```bash
node .claude/skills/deploy-mori/scripts/update.mjs
```

也可以直接让协作 agent「升级 mori」，由 deploy-mori skill 驱动同一脚本。`update.mjs` 会先执行 `git pull --rebase --autostash`，允许本地有少量 tracked 改动；如果拉取或 autostash 产生冲突，脚本中止，需手动处理后重试。拉取成功后，只要远端带来新提交、当前产物的 `dist/build-info.json` 不是当前 `HEAD`、`mori --version` 与源码 `package.json` 版本不一致、当前工作树有 tracked 改动，或 `node_modules` 缺失，就会执行 `pnpm install --frozen-lockfile`、`pnpm build`、迁移/补齐允许自动处理的 `setting.json` 字段，并在更新前 daemon 正在运行时重启。旧版本如果没有 `mori --version`，脚本按 `1.0.0` 处理。`pull`/`install`/`build` 任一步失败都不会停掉正在跑的 daemon，只有全部成功后才有一两秒重启窗口。

**全局包安装**（`pnpm add -g github:...`）则重新安装：

```bash
pnpm add -g github:DomenCai/mori   # 重新安装最新版
mori stop && mori start
```

`~/.mori/agent/soul.md` 和 `~/.mori/agent/response_style.md` 为空或只有 HTML 注释时，会自动使用升级后的内置 prompt；`~/.mori/agent/builtin/` 会在启动时刷新，方便查看当前版本。`~/.mori/` 下的用户配置、memory 和运行数据不受升级覆盖。

## 卸载

```bash
mori stop
pnpm remove -g mori
# 如需清除全部数据：rm -rf ~/.mori
```
