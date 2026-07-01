import { createLarkChannel, type LarkChannel } from "@larksuite/channel";
import type { LarkConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("lark-sdk");
const LARK_SDK_WARN_LEVEL = 2;

interface LarkSdkLogger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}

function summarizeLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        const code = "code" in arg ? ` code=${String(arg.code)}` : "";
        return `${arg.name}: ${arg.message}${code}`;
      }
      if (typeof arg === "string") return arg;
      if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
      if (arg && typeof arg === "object" && "code" in arg) {
        return `code=${String((arg as { code: unknown }).code)}`;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

const sdkLogger: LarkSdkLogger = {
  error: (...args: unknown[]) => log.error(summarizeLogArgs(args)),
  warn: (...args: unknown[]) => log.warn(summarizeLogArgs(args)),
  info: (...args: unknown[]) => log.info(summarizeLogArgs(args)),
  debug: (...args: unknown[]) => log.debug(summarizeLogArgs(args)),
  trace: (...args: unknown[]) => log.debug(summarizeLogArgs(args)),
};

export function initChannel(config: LarkConfig): LarkChannel {
  return createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    policy: {
      dmMode: "open",
      requireMention: false,
    },
    resolveChatMode: true,
    logger: sdkLogger,
    loggerLevel: LARK_SDK_WARN_LEVEL,
  });
}
