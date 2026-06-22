# 飞书命令

Personal Agent 的飞书命令都在消息正文里以 `/` 开头。命令处理完成后不会继续交给 Agent 对话模型。

## 会话与群

| 命令 | 作用 |
|---|---|
| `/help` | 显示命令列表 |
| `/new-diary-group` | 创建一个日记群，并把该 chat 绑定为 `diary` |
| `/new-chat <主题>` | 创建一个持续主题群，并把该 chat 绑定为 `topic` |
| `/new` | 重置当前 scope；重置前会先尝试蒸馏需要收尾的会话片段 |
| `/compact` | 压缩当前 scope 的上下文；压缩前也会先尝试蒸馏 scope episode |

日记群、私聊、主题群和飞书 thread 的续聊/新会话规则见 [会话与冷却规则](sessions.md)。

## Cognitive Lenses

| 命令 | 作用 |
|---|---|
| `/think <内容>` | 顺着「为什么会这样」往下钻，找更底层的解释 |
| `/rank <内容>` | 把一个领域降到两三根能生成现象的线 |
| `/plain <内容>` | 用大白话把概念讲到能复述 |

三条命令也可以作为回复使用：直接回复某条消息或知识卡片发 `/plain`，对象就是被回复的内容。光发命令且没有回复对象时不会进入 Agent，只会提示“命令后面给内容，或回复某条消息”。

Lens 是聊天流的变体，不是普通 CRUD 命令。它会走同一套流式卡片回复，但只读运行：不会晋升知识卡、不会写 vault frontmatter、不会把命令文本写成 `my_note`。日记群不支持 lens，`/think` 这类文本在日记群里按原日记路径处理。

## 身份画像

| 命令 | 作用 |
|---|---|
| `/profile` | 查看当前身份画像 |
| `/profile history` | 查看最近 10 条画像变更 |
| `/profile add <new_text>` | 手动追加画像文本 |
| `/profile remove <old_text>` | 删除画像中的唯一子串 |
| `/profile replace <old_text> => <new_text>` | 替换画像中的唯一子串 |

画像是慢变量。自动写画像只发生在周度合并；这些命令是显式手动纠错入口。

## Storylines 与 Daily Memory

| 命令 | 作用 |
|---|---|
| `/storylines` | 查看 active + recent dormant storylines |
| `/storyline <id>` | 查看单条 storyline 详情、证据 episode 和最近 revisions |
| `/storyline close <id>` | 手动把 storyline 软关闭为 `closed` |
| `/storyline reopen <id>` | 手动重新激活 storyline |
| `/dream` | 查看最近 7 条 daily memory run |
| `/dream YYYY-MM-DD` | 查看某天 daily memory run 的详细变更 |

`/working` 仍会被识别，但只提示“工作集已由 storylines 取代”。当前记忆层以 [记忆模型](memory-model.md) 为准。

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
- 通知群普通回复知识卡会把对应文件晋升到 Garden，并记录用户看法。
- 通知群话题回复知识卡会进入临时 thread 深聊；thread 关闭时再蒸馏 episode。
