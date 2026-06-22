# mori

一个**飞书优先的对话型个人思想伙伴**，基于 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 运行时。它不是日记 App，也不是任务执行平台，而是一个很懂我、能跟我交流的厉害朋友：我把日记、想法、有意思的知识丢给它，它读懂我、回应我，并在后台沉淀出越来越准的"关于我"的长期理解。

> 日记只是输入源，**记忆和长期上下文才是产品本体**。单用户、本地优先，不做多租户、不做 SaaS。

## 关于这个名字

**mori**，日语「森」，森林。这个字本身是三棵「木」叠起来的，木 → 林 → 森，越叠越繁茂。

选它是因为森林是「涌现」最好的例子：没人设计一片森林，一粒种子、无数生命相互作用，它自己长成繁茂的样子。一个真正懂你的伙伴也一样——那种「懂」不是预先设定出来的，是你把日记、想法、在意的东西丢给它，它读你读多了，自己慢慢长出来的。它本身就是一次涌现。

还有个意外的呼应：在希伯来语里，**mori** 是「我的老师」，也门犹太社区用它称呼拉比（rabbi）。一个陪你想事情、偶尔点破你盲点的伙伴，叫这个名也合适。

所以它不叫 personal-agent 那种功能名。它是一片只属于你自己的、安静繁茂的森林。

## 能做什么

- **日记群**：把日记发到日记群，流式回复像朋友聊天，后台顺手写一条 episode。
- **五层记忆**：身份画像（慢变、受保护）/ 当前主线（跨线阶段与主题）/ storylines（正在展开的生活叙事）/ fresh episodes / 原文归档（FTS 检索），始终在场而不膨胀。
- **每日记忆整理**：每天 06:00 处理前一天的 fresh episodes，维护 storylines，并在严格节流下判断是否轻触达。
- **周度总结**：每周日 23:55 读本周 daily runs、storylines 和 episode evidence，保守更新画像与当前主线，并发周记录。

完整文档入口见 [文档总览](docs/index.md)，设计历史见 [Design Index](design/index.md)。

## 快速开始

需要 Node ≥ 22.19、pnpm 10。

**本地开发**（数据落在项目内 `./data`，热重载）：

```bash
pnpm install
# 配置 LLM：编辑 data/setting.json 选模型，在 .env 填对应的 API key
pnpm dev            # 首次会弹出二维码，用飞书 App 扫码创建/授权应用
```

**作为 CLI 安装**（常驻后台，数据落在 `~/.mori`）：

```bash
pnpm add -g github:DomenCai/mori   # 替换为你的仓库
mori run      # 首次：前台扫码完成飞书注册
mori start    # 之后：后台守护运行
mori status   # 查看状态与日志路径
```

详见 [开发指南](docs/development.md) 与 [CLI 使用指南](docs/cli.md)。

## 飞书里的命令

| 命令 | 作用 |
|---|---|
| `/help` | 查看命令列表 |
| `/new-diary-group` | 创建日记群 |
| `/new-chat <主题>` | 创建持续主题群 |
| `/new` | 重置当前会话 |
| `/compact` | 压缩当前会话上下文 |
| `/consolidate` | 手动触发周度合并 |
| `/profile` | 查看身份画像（配合自然语言纠错） |
| `/profile history` | 查看画像变更历史 |
| `/storylines` | 查看 active + recent dormant 叙事线 |
| `/storyline <id>` | 查看或纠正单条叙事线 |
| `/dream` | 查看最近 daily_memory runs |
| `/schedules` | 查看和开关定时任务 |

## 文档

- [文档总览](docs/index.md) —— 当前功能文档入口和覆盖矩阵
- [飞书命令](docs/commands.md) —— 群、会话、画像、storylines、定时任务命令
- [记忆模型](docs/memory-model.md) —— 当前 profile / chapter / storylines / episodes / daily memory 语义
- [知识库](docs/knowledge-base.md) —— vault、Inbox/Garden、知识反应和知识工具
- [定时任务](docs/schedules.md) —— builtin、script 投喂和 knowledge index
- [配置参考](docs/configuration.md) —— runtime root、配置文件、模型路由和提示词位置
- [会话与冷却规则](docs/sessions.md) —— scope、续聊、新会话、thread/topic 冷却
- [开发指南](docs/development.md) —— 本地怎么跑、改提示词、看日志、调试
- [CLI 使用指南](docs/cli.md) —— 安装、守护进程、配置与日志位置
- [Design Index](design/index.md) —— dated design 目录入口和新旧优先级
