# 飞书命令

mori 的飞书命令都在消息正文里以 `/` 开头。命令处理完成后不会继续交给 Agent 对话模型。

## 会话与群

| 命令 | 作用 |
|---|---|
| `/help` | 显示命令列表 |
| `/new-diary-group` | 创建一个日记群，并把该 chat 绑定为 `diary` |
| `/new-clip-group` | 创建唯一收藏群，并把该 chat 绑定为 `clip` |
| `/clip <链接或文字>` | 直接收藏链接或文本；回复一条通知时可只发 `/clip` |
| `/new-chat <主题>` | 创建一个持续主题群，并把该 chat 绑定为 `topic` |
| `/new` | 重置当前 scope；重置前会先尝试蒸馏需要收尾的会话片段 |
| `/compact` | 压缩当前 scope 的上下文；压缩前也会先尝试蒸馏 scope episode |
| `/save [备注]` | 保存当前 session segment 内最近 60 条 user/assistant 文本 |

日记群、私聊、主题群和飞书 thread 的续聊/新会话规则见 [会话与冷却规则](sessions.md)。

## Cognitive Lenses

| 命令 | 作用 |
|---|---|
| `/think <内容>` | 顺着「为什么会这样」往下钻，找更底层的解释 |
| `/rank <内容>` | 把一个领域降到两三根能生成现象的线 |
| `/plain <内容>` | 用大白话把概念讲到能复述 |

三条命令也可以作为回复使用：直接回复某条消息或知识卡片发 `/plain`，对象就是被回复的内容。光发命令且没有回复对象时不会进入 Agent，只会提示“命令后面给内容，或回复某条消息”。

Lens 是聊天流的变体，不是普通 CRUD 命令。它会走同一套流式卡片回复，但只读运行：不会写 vault，也不会把命令文本写成笔记。日记群不支持 lens，`/think` 这类文本在日记群里按原日记路径处理。

## 身份画像

| 命令 | 作用 |
|---|---|
| `/profile` | 查看当前身份画像 |
| `/profile history` | 查看最近 10 条画像变更 |
| `/chapter` | 查看当前主线 |
| `/chapter history` | 查看最近 10 条当前主线变更 |

飞书命令只支持查看。身份画像修改使用 CLI：`mori profile add <文本>`、`mori profile remove <文本>`、`mori profile replace <旧文本> -- <新文本>`。当前主线需要手动纠正时，直接编辑 `memory/chapter.md`；下一次用户 turn 或 `/chapter` 查看时会同步进 SQLite，并记录 `manual_file_edit` 修订。

## Storylines 与 Daily Memory

| 命令 | 作用 |
|---|---|
| `/storylines` | 查看 active + recent dormant storylines |
| `/storyline <id>` | 查看单条 storyline 详情、证据 episode 和最近 revisions |
| `/dream` | 查看最近 7 天里有 storyline changes 的 daily memory run |
| `/dream <天数>` | 查看最近 N 天里有 storyline changes 的 daily memory run |
| `/dream YYYY-MM-DD` | 查看某天 daily memory run 的详细变更 |

飞书命令只支持查看。storyline 状态修改使用 CLI：`mori storyline close <id>`、`mori storyline reopen <id>`。当前记忆层以 [记忆模型](memory-model.md) 为准。

## 定时任务

| 命令 | 作用 |
|---|---|
| `/schedules` | 查看合并后的定时任务配置，并通过卡片按钮启停任务 |
| `/consolidate` | 手动触发周度合并 |

`/schedules` 的按钮只把启停覆盖写入 `schedules.json`，不会把代码内置默认任务完整落盘。定时任务细节见 [定时任务](schedules.md)。

## 非命令交互

- 日记群根消息会被当作一篇新日记：先写 episode，再流式回复。
- 日记群 reply/follow-up 是围绕同一篇日记继续聊，不强制写新 episode。
- 私聊、主题群、飞书 thread 是普通对话，可按需搜索记忆和 vault。
- 收藏群顶楼消息会直接入库并回反馈卡；长按原消息或反馈卡开话题后可继续深聊这篇。
- 通知群普通回复只提示后续操作，不写 episode，也不移动 vault 文件。
- 通知群话题回复知识卡会进入临时 thread 深聊；thread 关闭时再蒸馏 episode。需要收藏通知内容时，回复该通知发送 `/clip`。
