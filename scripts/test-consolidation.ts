// 一次性测试：对指定时间窗的 episode 跑 consolidation，把周报卡片真发到飞书日记群。
// channel.send 是 REST 调用，不建长连接，不与正在跑的 daemon 抢连接。
// 跑法：PERSONAL_AGENT_DEV=1 pnpm tsx scripts/test-consolidation.ts [since-iso] [--reset]
//   --reset：重跑前清空 consolidation 产物（profile/周报），保留 episode、message 与 storylines。
import { getDb, initDb, closeDb } from "../src/storage/db.js";
import { loadLlmConfig, resolveModelRoute, sessionsDir, loadLarkConfig } from "../src/config.js";
import { initChannel } from "../src/lark/channel.js";
import { HarnessManager } from "../src/agent/harness.js";
import { ChatRegistry } from "../src/lark/chatRegistry.js";
import { runConsolidation } from "../src/memory/consolidation.js";
import { EMPTY_PROFILE } from "../src/memory/service.js";

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const since = args.find((a) => !a.startsWith("--")) ?? "2026-03-01T00:00:00.000Z";

async function main() {
  const llmConfig = loadLlmConfig();
  const db = getDb();
  db.pragma("busy_timeout = 10000");
  initDb(db);

  const larkConfig = loadLarkConfig();
  if (!larkConfig) throw new Error("无 lark 配置（data/config.json）");
  const registry = new ChatRegistry(larkConfig, () => {});
  const channel = initChannel(larkConfig);

  if (reset) {
    db.exec("DELETE FROM weekly_summaries; DELETE FROM profile_revisions;");
    db.prepare("UPDATE profile SET content = ?, updated_at = ? WHERE id = 1").run(
      EMPTY_PROFILE,
      new Date().toISOString(),
    );
    console.log("已清空 consolidation 产物（保留 episode/message/storylines）");
  }

  const harnessManager = new HarnessManager({
    db,
    sessionsDir,
    routes: {
      companion: { name: "companion", ...resolveModelRoute("companion", llmConfig) },
      weekly: { name: "weekly", ...resolveModelRoute("weekly", llmConfig) },
    },
  });

  console.log(`跑 consolidation，窗口 since=${since}，日记群=${registry.getDiaryChats().join(",")}`);
  await runConsolidation(db, harnessManager, channel, registry, since);
  console.log("\n已发送到飞书。下面是落库结果：");
  const profile = db.prepare("SELECT content, updated_at FROM profile WHERE id=1").get() as any;
  console.log(`\n【身份画像】(updated ${profile?.updated_at})\n${profile?.content}`);

  const storylines = db
    .prepare("SELECT kind, title, status, summary, current_tension FROM storylines ORDER BY last_active_at DESC")
    .all() as any[];
  console.log(`\n【Storylines】${storylines.length} 条`);
  for (const item of storylines) {
    console.log(`  - [${item.kind}/${item.status}] ${item.title} — ${item.summary}`);
    if (item.current_tension) console.log(`      tension: ${item.current_tension}`);
  }

  const ws = db
    .prepare("SELECT week_key, summary FROM weekly_summaries ORDER BY created_at DESC LIMIT 1")
    .get() as any;
  console.log(`\n【周总结存档】${ws?.week_key}\n${ws?.summary}`);

  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
