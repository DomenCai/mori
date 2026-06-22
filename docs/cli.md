# CLI 使用指南

把 Personal Agent 作为常驻 CLI 安装、守护运行。本地开发见 [开发指南](development.md)。

## 安装

需要 Node ≥ 22.19、pnpm，macOS 需 Xcode Command Line Tools（`better-sqlite3` 安装时本地编译）。安装过程中 `prepare` 脚本会自动跑 `tsc` 编译，无需提前 build。

**从 GitHub 安装**（仓库含飞书 secret / LLM key，通常是 private，走你本机的 git 凭据）：

```bash
pnpm add -g github:DomenCai/PersonalAgent          # 替换为你的仓库
pnpm add -g github:DomenCai/PersonalAgent#v1.0.0    # 指定 tag/commit
```

**从本地安装**：

```bash
cd /path/to/PersonalAgent
pnpm add -g $(pwd)        # 安装当前目录
# 或开发期软链，改完即生效：
pnpm link --global
```

装好后获得 `personal-agent` 命令。

## 首次配置

后台守护无法扫码，**首次必须前台跑一次**完成飞书注册：

```bash
personal-agent run
```

终端渲染二维码，用飞书 App 扫码创建/授权应用，凭据写入 `~/.personal-agent/lark_config.json`。完成后 `Ctrl+C` 退出。

再配置 LLM key：编辑 `~/.personal-agent/.env`，填 `~/.personal-agent/setting.json` 里 `apiKeyEnv` 对应的 key。`setting.json` 首次缺失时会从仓库默认模板自动生成。

## 守护运行

```bash
personal-agent start     # 后台 detached 启动，写 pid，日志重定向到文件
personal-agent status    # 是否在运行 + pid + 运行中版本 + 日志路径
personal-agent stop      # 停止
personal-agent run       # 前台运行（调试 / 首次扫码用）
personal-agent -v        # 当前产物版本
```

`-v` 显示当前命令会运行的编译产物版本，来自 build 时写入的 `dist/build-info.json`。`status` 显示 daemon 启动时冻结进 pid 的启动版本；如果当前产物已经 rebuild 但 daemon 还没重启，`status` 会同时显示“启动版本”和“当前产物版本”。版本不读源码 `package.json`，裸 `git pull` 不影响，只有重新 build 才会变。

`start` 会先检查是否已在运行、飞书是否已配置，再 fork 后台进程。pid 文件由 `start` 写、`stop` 删，并记录进程启动时间和脚本路径；`stop/status` 会先校验进程归属，进程异常退出或 PID 复用后的残留 pid 会被识别和清理。旧格式 pid 文件若对应进程仍存活，会拒绝自动停止，避免误杀无关进程。

## 文件位置

全部在 `~/.personal-agent/` 下：

| 路径 | 内容 |
|---|---|
| `lark_config.json` | 飞书凭据、owner、chat 绑定 |
| `setting.json` | LLM、时区、会话、HTTP、script 和 knowledge index 配置 |
| `.env` | LLM API key |
| `agent/` | 提示词（`soul.md` 等），可按需修改 |
| `app.db` | SQLite 数据库 |
| `sessions/` | 会话状态，JSONL 文件按业务时区命名 |
| `logs/YYYY-MM-DD.log` | 运行日志，按业务时区切分 |
| `agent.pid` | 运行中进程的 pid |

## 日志

运行时 stdout/stderr 会按 `setting.time.timezone` 写入 `~/.personal-agent/logs/YYYY-MM-DD.log`。前台 `run` 会同时保留终端输出；后台 `start` 只写日志文件。

```bash
tail -f ~/.personal-agent/logs/$(date +%F).log
LOG_LEVEL=debug personal-agent run   # 临时调高日志级别
```

## 升级

**源码 checkout / link 部署**（当前安装目录本身就是本地 git 工作副本）在仓库根目录运行脚本升级：

```bash
node update.js
```

`update.js` 会先执行 `git pull --rebase --autostash`，允许本地有少量 tracked 改动；如果拉取或 autostash 产生冲突，脚本中止，需手动处理后重试。拉取成功后，只要远端带来新提交、当前产物的 `dist/build-info.json` 不是当前 `HEAD`、`personal-agent --version` 与源码 `package.json` 版本不一致、当前工作树有 tracked 改动，或 `node_modules` 缺失，就会执行 `pnpm install --frozen-lockfile`、`pnpm build`、按 allowlist 补齐允许自动补的 `setting.json` 缺失字段，并在更新前 daemon 正在运行时重启。旧版本如果没有 `personal-agent --version`，脚本按 `1.0.0` 处理。`pull`/`install`/`build` 任一步失败都不会停掉正在跑的 daemon，只有全部成功后才有一两秒重启窗口。

**全局包安装**（`pnpm add -g github:...`）则重新安装：

```bash
pnpm add -g github:DomenCai/PersonalAgent   # 重新安装最新版
personal-agent stop && personal-agent start
```

`~/.personal-agent/` 下的配置和数据不受升级影响。

## 卸载

```bash
personal-agent stop
pnpm remove -g personal-agent
# 如需清除全部数据：rm -rf ~/.personal-agent
```
