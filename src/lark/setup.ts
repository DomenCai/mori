import { registerApp } from "@larksuite/channel";
import qrcode from "qrcode-terminal";
import type { LarkConfig } from "../config.js";

const DOMAIN_BY_TENANT: Record<"feishu" | "lark", string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};

/**
 * 首次运行：终端渲染二维码，用户用飞书 App 扫码创建/授权应用，
 * registerApp 直接回填 appId / appSecret / 扫码人 open_id。
 */
export async function runRegistrationWizard(): Promise<LarkConfig> {
  console.log("\n未检测到飞书应用配置，进入扫码创建向导。\n");

  const result = await registerApp({
    source: "mori",
    appPreset: { name: "mori" },
    onQRCodeReady: (info) => {
      console.log("请用飞书 App 扫描以下二维码完成应用创建/授权：\n");
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期约 ${mins} 分钟。`);
      console.log(`也可在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === "domain_switched") {
        console.log("识别到国际版租户，已切换到 Lark 域名。");
      } else if (info.status === "slow_down") {
        console.log("轮询过快，已自动降速。");
      }
    },
  });

  const tenant = result.user_info?.tenant_brand ?? "feishu";
  const ownerOpenId = result.user_info?.open_id;

  console.log("\n✓ 应用就绪");
  console.log(`  App ID: ${result.client_id}`);
  console.log(`  Tenant: ${tenant}`);
  if (ownerOpenId) {
    console.log(`  Owner:  ${ownerOpenId}`);
  } else {
    console.log("  ⚠️ 未获取到扫码用户 open_id；首个在私聊发消息的人将自动成为 owner。");
  }

  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    domain: DOMAIN_BY_TENANT[tenant],
    tenant,
    ...(ownerOpenId ? { ownerOpenId } : {}),
  };
}
