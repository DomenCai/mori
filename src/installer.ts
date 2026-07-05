import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface BuildInfo {
  name: string;
  version: string;
}

function loadBuildInfo(): BuildInfo {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(distDir, "build-info.json"), "utf-8"),
  ) as BuildInfo;
}

export async function install(): Promise<void> {
  const { name, version } = loadBuildInfo();
  const packageSpec = `${name}@${version}`;

  console.log(`正在持久安装 ${packageSpec}…`);
  const result = spawnSync("npm", ["install", "--global", packageSpec], {
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`无法执行 npm：${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const rootResult = spawnSync("npm", ["root", "--global"], {
    encoding: "utf-8",
  });
  if (rootResult.error || rootResult.status !== 0) {
    throw new Error("无法定位 npm 全局安装目录");
  }

  const globalMain = join(
    rootResult.stdout.trim(),
    name,
    "dist",
    "main.js",
  );
  if (!existsSync(globalMain)) {
    throw new Error(`全局 CLI 入口不存在：${globalMain}`);
  }

  console.log("持久安装完成，进入配置向导…");
  const setupResult = spawnSync(process.execPath, [globalMain, "setup"], {
    stdio: "inherit",
  });
  if (setupResult.error) {
    throw new Error(`无法启动配置向导：${setupResult.error.message}`);
  }
  if (setupResult.status !== 0) {
    process.exit(setupResult.status ?? 1);
  }
}
