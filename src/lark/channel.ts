import { createLarkChannel, type LarkChannel } from "@larksuite/channel";
import type { LarkConfig } from "../config.js";

export function initChannel(config: LarkConfig): LarkChannel {
  return createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    policy: {
      dmMode: "open",
      requireMention: false,
    },
  });
}
