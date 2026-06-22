# Scripts

本目录放本地开发、调试和一次性维护脚本。默认用 `pnpm tsx` 直接运行，不通过 daemon。

## 规则

- 不要默认 stage 或提交脚本产生的结果。
- 调试脚本应优先只读；如果会写数据库、发飞书消息或调用 LLM，必须在 help 文本里写清楚。
- 查看数据库内容使用 `inspect-db.ts`；它以 readonly 模式打开 SQLite，不调用 `initDb()`，不会建表、补数据或改业务状态。
- 历史日记回放使用 `backfill-diary.ts`；它会写数据库并调用 LLM，只应该在明确需要导入/回放时运行。

## inspect-db.ts

只读查看 `data/app.db` 或指定 SQLite 文件。

```bash
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts summary
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts integrity
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts day 2026-06-16
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts week 2026-W24
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts storylines --status active
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts profile
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts profile-history --limit 10
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts episodes --limit 20
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts episode ep_xxx --with-source
```

常用参数：

```bash
--db <path>       # 指定 DB；默认开发态 data/app.db，生产态 ~/.mori/app.db
--json            # 输出 JSON
--full            # 不截断长文本
--limit <n>       # 列表条数
--status <value>  # storylines 状态过滤：active / dormant / closed
--with-source     # 查看 episode 时带来源消息
```

### 推荐检查顺序

导入或回放后先看整体：

```bash
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts summary
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts integrity
```

如果要看某一天是否完成 dream：

```bash
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts day 2026-06-16
```

如果要看某周周总结和画像变更：

```bash
MORI_DEV=1 pnpm tsx scripts/inspect-db.ts week 2026-W24
```

## backfill-diary.ts

历史日记导入和回放脚本。会写数据库并调用 LLM。

```bash
MORI_DEV=1 pnpm tsx scripts/backfill-diary.ts diary-data --dry-run
MORI_DEV=1 pnpm tsx scripts/backfill-diary.ts diary-data --week-start 2026-06-15 --skip-weekly
MORI_DEV=1 pnpm tsx scripts/backfill-diary.ts diary-data
```

要点：

- 默认按 `### HH:MM` section 拆成多条 import message。
- 每天先导入当天日记，再跑当天 daily memory。
- 每周末跑 weekly consolidation；当前未结束周可用 `--skip-weekly`。
- 全量模式要求 fresh DB；`--week-start` 可用于按周续跑。
