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

终端渲染二维码，用飞书 App 扫码创建/授权应用，凭据写入 `~/.personal-agent/config.json`。完成后 `Ctrl+C` 退出。

再配置 LLM key：编辑 `~/.personal-agent/.env`，填 `~/.personal-agent/llm-providers.json` 里 `apiKeyEnv` 对应的 key。这两个文件首次运行时会从仓库默认模板自动生成。

## 守护运行

```bash
personal-agent start     # 后台 detached 启动，写 pid，日志重定向到文件
personal-agent status    # 是否在运行 + pid + 日志路径
personal-agent stop      # 停止
personal-agent run       # 前台运行（调试 / 首次扫码用）
```

`start` 会先检查是否已在运行、飞书是否已配置，再 fork 后台进程。pid 文件由 `start` 写、`stop` 删，并记录进程启动时间和脚本路径；`stop/status` 会先校验进程归属，进程异常退出或 PID 复用后的残留 pid 会被识别和清理。旧格式 pid 文件若对应进程仍存活，会拒绝自动停止，避免误杀无关进程。

## 文件位置

全部在 `~/.personal-agent/` 下：

| 路径 | 内容 |
|---|---|
| `config.json` | 飞书凭据、owner、chat 绑定 |
| `.env` | LLM API key |
| `llm-providers.json` | provider / 模型 / 路由配置 |
| `agent/` | 提示词（`soul.md` 等），可按需修改 |
| `app.db` | SQLite 数据库 |
| `sessions/` | 会话状态，JSONL 文件按上海时间命名 |
| `logs/YYYY-MM-DD.log` | 运行日志，按上海日期切分 |
| `agent.pid` | 运行中进程的 pid |

## 日志

运行时 stdout/stderr 会按上海日期写入 `~/.personal-agent/logs/YYYY-MM-DD.log`。前台 `run` 会同时保留终端输出；后台 `start` 只写日志文件。

```bash
tail -f ~/.personal-agent/logs/$(date +%F).log
LOG_LEVEL=debug personal-agent run   # 临时调高日志级别
```

## 升级

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
