import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { AgentHarnessStreamOptions, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CacheRetention, Model } from "@earendil-works/pi-ai";
import { logger } from "./log.js";
import { setBusinessTimeZone } from "./utils.js";

const log = logger("init");

interface LlmProviderConfig {
  api: string;
  baseUrl: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  request?: {
    cacheRetention?: CacheRetention;
  };
  models: Record<string, LlmModelConfig>;
}

interface LlmModelConfig {
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

interface ModelProfile {
  provider: string;
  model: string;
}

export type LlmRouteConfig = string | {
  profile: string;
  thinkingLevel?: ThinkingLevel;
};

export interface LlmConfig {
  providers: Record<string, LlmProviderConfig>;
  model_profiles: Record<string, ModelProfile>;
  routes: Record<string, LlmRouteConfig>;
}

export interface SessionPolicyItem {
  autoClose: boolean;
  idleMinutes?: number;
}

export interface SessionPolicyConfig {
  diary: SessionPolicyItem;
  dm: SessionPolicyItem;
  thread: SessionPolicyItem;
  topic: SessionPolicyItem;
}

export interface SettingConfig {
  llm: LlmConfig;
  time: {
    timezone: string;
  };
  sessions: {
    sweepIntervalMs: number;
    policies: SessionPolicyConfig;
  };
  script: {
    defaults: ScriptRuntimeConfig;
  };
  http: {
    fetch: {
      timeoutMs: number;
      userAgent: string;
    };
  };
  knowledge: {
    index: {
      checkIntervalMs: number;
    };
  };
}

export interface ScriptRuntimeConfig {
  timeoutMs: number;
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
  };
}

let _config: LlmConfig | null = null;
let _setting: SettingConfig | null = null;

export function loadSetting(): SettingConfig {
  if (_setting) return _setting;
  const setting = JSON.parse(readFileSync(settingPath, "utf-8")) as SettingConfig;
  setBusinessTimeZone(setting.time.timezone);
  _setting = setting;
  return _setting;
}

export function loadLlmConfig(): LlmConfig {
  if (_config) return _config;
  _config = loadSetting().llm;
  return _config;
}

export function resolveModelRoute(
  routeName: string,
  config?: LlmConfig,
): {
  model: Model<any>;
  apiKey: string;
  streamOptions: AgentHarnessStreamOptions;
  thinkingLevel?: ThinkingLevel;
} {
  const cfg = config ?? loadLlmConfig();
  const route = cfg.routes[routeName];
  if (!route) throw new Error(`未找到路由: ${routeName}`);
  const profileName = typeof route === "string" ? route : route.profile;
  const thinkingLevel = typeof route === "string" ? undefined : route.thinkingLevel;

  const profile = cfg.model_profiles[profileName];
  if (!profile) throw new Error(`未找到模型配置: ${profileName}`);

  const provider = cfg.providers[profile.provider];
  if (!provider) throw new Error(`未找到 provider: ${profile.provider}`);

  const modelConfig = provider.models[profile.model];
  if (!modelConfig) {
    throw new Error(`未找到模型: ${profile.provider}.${profile.model}`);
  }

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) throw new Error(`环境变量 ${provider.apiKeyEnv} 未设置`);

  const model: Model<any> = {
    id: profile.model,
    name: modelConfig.name,
    api: provider.api,
    provider: profile.provider,
    baseUrl: provider.baseUrl,
    reasoning: modelConfig.reasoning,
    input: modelConfig.input,
    cost: {
      input: modelConfig.cost?.input ?? 0,
      output: modelConfig.cost?.output ?? 0,
      cacheRead: modelConfig.cost?.cacheRead ?? 0,
      cacheWrite: modelConfig.cost?.cacheWrite ?? 0,
    },
    contextWindow: modelConfig.contextWindow,
    maxTokens: modelConfig.maxTokens,
    headers: provider.headers,
  };

  return {
    model,
    apiKey,
    streamOptions: provider.request?.cacheRetention
      ? { cacheRetention: provider.request.cacheRetention }
      : {},
    thinkingLevel,
  };
}

// ── 路径解析 ──
// 运行时状态（lark_config.json / app.db / sessions）与用户可改文件（.env /
// setting.json / agent 提示词）都挂在 ROOT 下：
//   正常运行 → ~/.personal-agent；调试（pnpm dev 设 PERSONAL_AGENT_DEV）→ 项目内 ./data。
// 用户可改文件首次缺失时，从仓库内置默认拷贝过去。
const isDev = !!process.env.PERSONAL_AGENT_DEV;
const ROOT = isDev ? join(process.cwd(), "data") : join(homedir(), ".personal-agent");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LARK_CONFIG_FILE = join(ROOT, "lark_config.json");
export const rootDir = ROOT;
export const sessionsDir = join(ROOT, "sessions");
export const dbPath = join(ROOT, "app.db");
export const logsDir = join(ROOT, "logs");
export const pidPath = join(ROOT, "agent.pid");
export const vaultDir = join(ROOT, "vault");
export const scriptDir = join(ROOT, "script");
export const schedulesPath = join(ROOT, "schedules.json");
export const knowledgeIndexPath = join(vaultDir, ".index.md");

/** 用户可改的单个文件：调试用仓库原位，生产放 ROOT；缺失时从示例 seed。 */
function userFile(name: string, devPath: string, seedFrom = devPath): string {
  const target = isDev ? devPath : join(ROOT, name);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(seedFrom, target);
    log.info(`已生成 ${target}，可按需修改`);
  }
  return target;
}

/** 用户可改的整个目录（agent 提示词），仅补齐必需的缺失 seed 文件。 */
function userDir(
  name: string,
  devPath: string,
  requiredFiles: readonly string[],
): string {
  if (isDev) return devPath;
  const target = join(ROOT, name);
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    log.info(`已生成 ${target}，可按需修改`);
  }

  if (!statSync(target).isDirectory()) {
    throw new Error(`${target} 已存在但不是目录`);
  }

  for (const file of requiredFiles) {
    const targetFile = join(target, file);
    if (!existsSync(targetFile)) {
      mkdirSync(dirname(targetFile), { recursive: true, mode: 0o700 });
      copyFileSync(join(devPath, file), targetFile);
      log.info(`已补齐 ${targetFile}，可按需修改`);
    }
  }

  return target;
}

export const settingPath = userFile(
  "setting.json",
  join(REPO_ROOT, "data", "setting.json"),
  join(REPO_ROOT, "data", "setting.example.json"),
);
export const agentDir = userDir("agent", join(REPO_ROOT, "agent"), [
  "soul.md",
  "memory_policy.md",
  "response_style.md",
]);

// .env 必须先于任何环境变量读取；生产首次从 .env.example seed（占位 key 需用户填）。
loadEnv({ path: userFile(".env", join(REPO_ROOT, ".env"), join(REPO_ROOT, ".env.example")) });

export interface LarkConfig {
  appId: string;
  appSecret: string;
  domain: string;
  tenant: "feishu" | "lark";
  /** 扫码人 open_id；飞书未返回时为空，由首条私聊消息绑定。 */
  ownerOpenId?: string;
  /** 飞书 chat 绑定属于运行配置，不能依赖 app.db，否则重建数据库会丢群绑定。 */
  chatBindings?: LarkChatBinding[];
}

export type LarkChatType = "diary" | "topic" | "notification" | "dm";

export interface LarkChatBinding {
  chatId: string;
  chatType: LarkChatType;
  name?: string;
  createdAt: string;
}

export function loadLarkConfig(): LarkConfig | null {
  if (!existsSync(LARK_CONFIG_FILE)) return null;
  return JSON.parse(readFileSync(LARK_CONFIG_FILE, "utf-8")) as LarkConfig;
}

export function saveLarkConfig(cfg: LarkConfig): void {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const clean: LarkConfig = {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain,
    tenant: cfg.tenant,
    ...(cfg.ownerOpenId ? { ownerOpenId: cfg.ownerOpenId } : {}),
    ...(cfg.chatBindings ? { chatBindings: cfg.chatBindings } : {}),
  };
  writeFileSync(LARK_CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
}
