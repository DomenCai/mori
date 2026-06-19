// 一次性脚本：把 Obsidian 历史日记重新蒸馏成 episode 导入本系统。
// 复刻线上日记管线：先合成一条 user message（日记本就是日记群里的一条用户消息），
// 再用 diary harness 调 write_episode 落 episode 并挂上 source_message_id。
// 跑法：pnpm tsx scripts/import-diary.ts [日记根目录]
//   默认目录 ~/Documents/Obsidian/diary/raw；目标库由 PERSONAL_AGENT_DEV 决定（与 daemon 一致）。
// 幂等：已导入的日期会跳过，可中断续跑。跑完即可删除本脚本。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { NormalizedMessage } from "@larksuite/channel";
import { getDb, initDb, closeDb } from "../src/storage/db.js";
import { loadLlmConfig, resolveModelRoute, sessionsDir, loadLarkConfig } from "../src/config.js";
import { HarnessManager } from "../src/agent/harness.js";
import { ChatRegistry } from "../src/lark/chatRegistry.js";
import type { EpisodeSource } from "../src/diary/service.js";

const rawDir =
  process.argv[2] ?? join(homedir(), "Documents/Obsidian/diary/raw");

// 取不到真实日记群时用常量 scope —— 回读走 source_message_id，scope 仅作归类。
const FALLBACK_SCOPE = "diary_import";

function listDiaryFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((p) => p.endsWith(".md") && /\d{4}-\d{2}-\d{2}\.md$/.test(p))
    .map((p) => join(dir, p))
    .sort();
}

function parseDate(path: string): string {
  const m = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  if (!m) throw new Error(`无法从文件名解析日期: ${path}`);
  return m[1];
}

// 篇内 ### HH:MM 小标题：首条作起点、末条作终点；都缺则用 09:00。
function parseTimeWindow(date: string, raw: string): { startedAt: string; endedAt: string } {
  const times = [...raw.matchAll(/^###\s*(\d{1,2}):(\d{2})/gm)].map(
    (m) => `${m[1].padStart(2, "0")}:${m[2]}`,
  );
  const toIso = (hm: string) => new Date(`${date}T${hm}:00+08:00`).toISOString();
  if (times.length === 0) return { startedAt: toIso("09:00"), endedAt: toIso("09:00") };
  return { startedAt: toIso(times[0]), endedAt: toIso(times[times.length - 1]) };
}

async function main() {
  const llmConfig = loadLlmConfig();
  const db = getDb();
  db.pragma("busy_timeout = 10000"); // daemon 可能同时在写 dev 库，避免撞 SQLITE_BUSY
  initDb(db);

  const larkConfig = loadLarkConfig();
  const diaryScope =
    (larkConfig && new ChatRegistry(larkConfig, () => {}).getDiaryChats()[0]) ||
    FALLBACK_SCOPE;

  const harnessManager = new HarnessManager({
    db,
    sessionsDir,
    routes: {
      companion: { name: "companion", ...resolveModelRoute("companion", llmConfig) },
      weekly: { name: "weekly", ...resolveModelRoute("weekly", llmConfig) },
    },
  });

  const diaryService = harnessManager.getDiaryService();
  const messageService = harnessManager.getMessageService();

  const files = listDiaryFiles(rawDir);
  console.log(`发现 ${files.length} 篇日记，目标 scope=${diaryScope}\n`);

  let imported = 0;
  let skipped = 0;
  for (const [i, file] of files.entries()) {
    const date = parseDate(file);
    const raw = readFileSync(file, "utf-8").trim();
    const messageId = `diary_import:${date}`;
    const tag = `[${i + 1}/${files.length}] ${date}`;

    if (!raw) {
      console.log(`${tag} 空文件，跳过`);
      skipped++;
      continue;
    }
    if (diaryService.hasEpisodeForMessage(messageId)) {
      console.log(`${tag} 已导入，跳过`);
      skipped++;
      continue;
    }

    const { startedAt, endedAt } = parseTimeWindow(date, raw);

    // 1. 合成 user message —— 复刻线上 saveUserMessage（日记群里的一条用户消息）。
    messageService.saveUserMessage({
      messageId,
      chatId: diaryScope,
      content: raw,
      createTime: new Date(endedAt).getTime(),
    } as unknown as NormalizedMessage);

    const source: EpisodeSource = {
      scopeId: diaryScope,
      messageId,
      startedAt,
      endedAt,
    };

    // 2. 每篇用独立 ephemeral harness scope，避免 38 篇挤进同一 session 撑爆上下文。
    const harnessScope = `import_${date}`;
    const entry = await harnessManager.getOrCreate(harnessScope, "diary");
    harnessManager.setCurrentEpisodeSource(harnessScope, source);
    await entry.harness.setActiveTools(["write_episode"]);

    try {
      await entry.harness.prompt(`[日记群新日记]
这是一篇历史日记，请只调用 write_episode 工具把原文蒸馏成 episode，不要输出面向用户的回复文本。

原文：
${raw}`);
    } catch (err) {
      console.warn(`${tag} prompt 失败，落兜底 episode:`, err);
    }

    // 3. 兜底：模型没写 episode 就存最小兜底（照搬线上 ensureDiaryEpisode）。
    if (!diaryService.hasEpisodeForMessage(messageId)) {
      diaryService.saveFallbackEpisode(source, raw);
      console.log(`${tag} 模型未写 episode，已兜底`);
    } else {
      console.log(`${tag} ✓ 已蒸馏`);
    }

    await harnessManager.resetSession(harnessScope);
    imported++;
  }

  console.log(`\n完成：导入 ${imported} 篇，跳过 ${skipped} 篇。`);
  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
