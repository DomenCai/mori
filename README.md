# Personal Agent

一个**飞书优先的对话型个人 Agent**，基于 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 运行时。它不是日记 App，也不是任务执行平台，而是一个很懂我、能跟我交流的厉害朋友：我把日记、想法、有意思的知识丢给它，它读懂我、回应我，并在后台沉淀出越来越准的"关于我"的长期理解。

> 日记只是输入源，**记忆和长期上下文才是产品本体**。单用户、本地优先，不做多租户、不做 SaaS。

## 能做什么

- **日记群**：把日记发到日记群，流式回复像朋友聊天，后台顺手写一条 episode。
- **四层记忆**：身份画像（慢变、受保护）/ 工作集（在做的项目）/ 最近 episode / 原文归档（FTS 检索），始终在场而不膨胀。
- **周度总结**：每周日 23:55 读本周日记产出总结，并保守更新画像、增量更新工作集。
- **记日记提醒**：超过 3 天没记，每天一次提醒。

完整产品设计见 [需求文档](docs/personal-agent-mvp.md)，架构实现见 [实施规划](docs/personal-agent-mvp-impl.md)。

## 快速开始

需要 Node ≥ 22.19、pnpm 10。

**本地开发**（数据落在项目内 `./data`，热重载）：

```bash
pnpm install
# 配置 LLM：编辑 data/llm-providers.json 选模型，在 .env 填对应的 API key
pnpm dev            # 首次会弹出二维码，用飞书 App 扫码创建/授权应用
```

**作为 CLI 安装**（常驻后台，数据落在 `~/.personal-agent`）：

```bash
pnpm add -g github:DomenCai/PersonalAgent   # 替换为你的仓库
personal-agent run      # 首次：前台扫码完成飞书注册
personal-agent start    # 之后：后台守护运行
personal-agent status   # 查看状态与日志路径
```

详见 [开发指南](docs/development.md) 与 [CLI 使用指南](docs/cli.md)。

## 飞书里的命令

| 命令 | 作用 |
|---|---|
| `/help` | 查看命令列表 |
| `/new-diary-group` | 创建日记群 |
| `/new` | 重置当前会话 |
| `/compact` | 压缩当前会话上下文 |
| `/consolidate` | 手动触发周度合并 |
| `/profile` | 查看身份画像（配合自然语言纠错） |
| `/working` | 查看工作集（配合自然语言纠错） |

## 文档

- [需求文档](docs/personal-agent-mvp.md) —— 要做什么、为什么
- [实施规划](docs/personal-agent-mvp-impl.md) —— 架构、数据模型、目录结构
- [开发指南](docs/development.md) —— 本地怎么跑、改提示词、看日志、调试
- [CLI 使用指南](docs/cli.md) —— 安装、守护进程、配置与日志位置
