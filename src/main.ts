#!/usr/bin/env node

const command = process.argv[2] ?? "run";

if (command === "install" || command === "setup") {
  try {
    if (command === "install") {
      const { install } = await import("./installer.js");
      await install();
    } else {
      const { setup } = await import("./setup.js");
      await setup();
    }
  } catch (err) {
    console.error(
      `${command === "install" ? "安装" : "配置"}失败：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }
} else {
  await import("./cli.js");
}
