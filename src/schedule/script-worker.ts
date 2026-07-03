import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { buildScheduleScriptContext } from "./context.js";

interface WorkerData {
  scriptPath: string;
  scheduleId: string;
  context?: unknown;
  timezone: string;
}

async function main(): Promise<void> {
  const data = workerData as WorkerData;
  const mod = await import(pathToFileURL(data.scriptPath).href);
  if (typeof mod.default !== "function") {
    throw new Error("script 必须 default export 一个 async function");
  }
  const result = await mod.default(buildScheduleScriptContext({
    scheduleId: data.scheduleId,
    context: data.context,
    timezone: data.timezone,
  }));
  parentPort?.postMessage({ ok: true, result });
}

main().catch((err) => {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
});
