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
import type { AgentHarnessStreamOptions } from "@earendil-works/pi-agent-core";
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

export type AgentChatType =
  | "diary"
  | "dm"
  | "topic"
  | "thread"
  | "distill"
  | "consolidation"
  | "review"
  | "daily_memory"
  | "schedule";

/** 没有为某个 chatType 配置档位时使用的默认档位。 */
export const DEFAULT_PROFILE = "normal";

export interface LlmConfig {
  providers: Record<string, LlmProviderConfig>;
  /** 语义档位：normal / strong，是"强模型到底是哪个"的唯一真源。 */
  model_profiles: Record<string, ModelProfile>;
  /** chatType → 档位名；未列出的 chatType 走 DEFAULT_PROFILE。 */
  chat_types: Partial<Record<AgentChatType, string>>;
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

export interface KnowledgeSearchConfig {
  provider: "tavily" | "brave";
  apiKeyEnv: string;
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
    search: KnowledgeSearchConfig;
  };
}

export interface ScriptRuntimeConfig {
  timeoutMs: number;
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
  };
}

export interface BuildInfo {
  name: string;
  version: string;
  builtAt: string | null;
  gitCommit: string | null;
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

export function resolveProfile(
  profileName: string,
  config?: LlmConfig,
): {
  model: Model<any>;
  apiKey: string;
  streamOptions: AgentHarnessStreamOptions;
} {
  const cfg = config ?? loadLlmConfig();
  const profile = cfg.model_profiles[profileName];
  if (!profile) throw new Error(`未找到模型档位: ${profileName}`);

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
  };
}

// ── 路径解析 ──
// 运行时状态（lark_config.json / app.db / sessions）与用户可改文件（.env /
// setting.json / agent 提示词）都挂在 ROOT 下：
//   正常运行 → ~/.mori；调试（pnpm dev 设 MORI_DEV）→ 项目内 ./data。
// 用户可改文件首次缺失时，从仓库内置默认拷贝过去。
const isDev = !!process.env.MORI_DEV;
const ROOT = isDev ? join(process.cwd(), "data") : join(homedir(), ".mori");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 生产读构建时冻结在 dist/build-info.json 的产物信息；dev 下 fallback 到源码 package.json。
// 不缓存：update.mjs 会在自身生命周期内 build 出新 dist，需读到 build 后的新值。
export function loadBuildInfo(): BuildInfo {
  const localBuildInfo = join(dirname(fileURLToPath(import.meta.url)), "build-info.json");
  if (existsSync(localBuildInfo)) {
    const info = JSON.parse(readFileSync(localBuildInfo, "utf-8")) as Partial<BuildInfo>;
    if (typeof info.version === "string" && info.version.length > 0) {
      return {
        name: typeof info.name === "string" && info.name ? info.name : "mori",
        version: info.version,
        builtAt: typeof info.builtAt === "string" ? info.builtAt : null,
        gitCommit: typeof info.gitCommit === "string" ? info.gitCommit : null,
      };
    }
  }

  const pkgPath = join(REPO_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return {
    name: typeof pkg.name === "string" ? pkg.name : "mori",
    version: pkg.version as string,
    builtAt: null,
    gitCommit: null,
  };
}

export function loadAppVersion(): string {
  return loadBuildInfo().version;
}

const LARK_CONFIG_FILE = join(ROOT, "lark_config.json");
export const rootDir = ROOT;
export const repoDir = REPO_ROOT;
export const isDevMode = isDev;
export const builtinAgentDir = join(REPO_ROOT, "agent");
export const sessionsDir = join(ROOT, "sessions");
export const dbPath = join(ROOT, "app.db");
export const logsDir = join(ROOT, "logs");
export const pidPath = join(ROOT, "agent.pid");
export const vaultDir = join(ROOT, "vault");
export const memoryDir = join(ROOT, "memory");
export const scriptDir = join(ROOT, "script");
export const schedulesPath = join(ROOT, "schedules.json");

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

const USER_PROMPT_FILES = ["soul.md", "response_style.md"] as const;
const BUILTIN_PROMPT_FILES = ["soul.md", "memory_policy.md", "knowledge_policy.md", "response_style.md"] as const;

const USER_PROMPT_TEMPLATE = `<!--
这里可以写你的个人 override。

保持本文件为空，或只保留 HTML 注释时，mori 会使用内置版本。
改完后，下一次构造 system prompt 生效。
-->
`;

const AGENT_README = `# mori agent

这个目录用于放用户可编辑的 agent override。

- soul.md：可选，覆盖内置人格内核。
- response_style.md：可选，覆盖内置回应风格。
- builtin/：当前版本内置提示词的只读参考，启动时会被刷新，运行时不会读取。
- memory_policy.md / knowledge_policy.md 固定使用内置版本，不能通过这里覆盖。

规则：

- mori 会先去掉 HTML 注释，再判断文件是否为空。
- 文件为空或只有注释时，使用内置版本。
- 用户 override 会在下一次构造 system prompt 时生效。
- 当前身份画像和当前主线在 ../memory/profile.md 与 ../memory/chapter.md。
`;

/** 生产态 agent 目录：只 seed 用户 override 和说明；builtin 仅展示，运行时不读。 */
function userAgentDir(): string {
  if (isDev) return builtinAgentDir;
  const target = join(ROOT, "agent");
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    log.info(`已生成 ${target}，可按需修改`);
  }

  if (!statSync(target).isDirectory()) {
    throw new Error(`${target} 已存在但不是目录`);
  }

  for (const file of USER_PROMPT_FILES) {
    const targetFile = join(target, file);
    if (!existsSync(targetFile)) {
      mkdirSync(dirname(targetFile), { recursive: true, mode: 0o700 });
      writeFileSync(targetFile, USER_PROMPT_TEMPLATE, { mode: 0o600 });
      log.info(`已补齐 ${targetFile}，可按需修改`);
    }
  }

  const readmeFile = join(target, "README.md");
  if (!existsSync(readmeFile)) {
    writeFileSync(readmeFile, AGENT_README, { mode: 0o600 });
    log.info(`已生成 ${readmeFile}`);
  }

  const builtinViewDir = join(target, "builtin");
  mkdirSync(builtinViewDir, { recursive: true, mode: 0o700 });
  for (const file of BUILTIN_PROMPT_FILES) {
    copyFileSync(join(builtinAgentDir, file), join(builtinViewDir, file));
  }

  return target;
}

export const settingPath = userFile(
  "setting.json",
  join(REPO_ROOT, "data", "setting.json"),
  join(REPO_ROOT, "data", "setting.example.json"),
);
export const agentDir = userAgentDir();

// .env 必须先于任何环境变量读取；生产首次从 .env.example seed（占位 key 需用户填）。
loadEnv({ path: userFile(".env", join(REPO_ROOT, ".env"), join(REPO_ROOT, ".env.example")) });

export interface LarkConfig {
  appId: string;
  appSecret: string;
  domain: string;
  tenant: "feishu" | "lark";
  /** 扫码人 open_id；飞书未返回时为空，由首条私聊消息绑定。 */
  ownerOpenId?: string;
  /** 首次欢迎引导已推送的时间戳；存在即不再重复推送。 */
  onboardedAt?: string;
  /** 飞书 chat 绑定属于运行配置，不能依赖 app.db，否则重建数据库会丢群绑定。 */
  chatBindings?: LarkChatBinding[];
}

export type LarkChatType = "diary" | "topic" | "notification" | "dm" | "clip";

export interface LarkChatBinding {
  chatId: string;
  chatType: LarkChatType;
  name?: string;
  /** 仅用于 notification：标记默认通知群，按标记而非群名识别（群名可被改）。 */
  isDefault?: boolean;
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
    ...(cfg.onboardedAt ? { onboardedAt: cfg.onboardedAt } : {}),
    ...(cfg.chatBindings ? { chatBindings: cfg.chatBindings } : {}),
  };
  writeFileSync(LARK_CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
}
