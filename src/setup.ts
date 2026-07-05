import { confirm, input, password, search, select } from "@inquirer/prompts";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ApiProtocol =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses";

interface ProtocolOption {
  api: ApiProtocol;
  label: string;
  defaultBaseUrl: string;
}

interface DiscoveredModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  imageInput?: boolean;
}

interface ModelMetadata {
  contextWindow: number;
  maxTokens: number;
}

interface PriceRow {
  pattern: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SetupAnswers {
  api: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  normalModel: string;
  strongModel: string;
  discovered: Map<string, DiscoveredModel>;
}

const PROTOCOLS: ProtocolOption[] = [
  {
    api: "anthropic-messages",
    label: "Anthropic Messages",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  {
    api: "openai-completions",
    label: "OpenAI Chat Completions",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    api: "openai-responses",
    label: "OpenAI Responses",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
];

const MANUAL_MODEL = "__manual_model__";
const ROOT = join(homedir(), ".mori");
const SETTING_PATH = join(ROOT, "setting.json");
const ENV_PATH = join(ROOT, ".env");
const LARK_PATH = join(ROOT, "lark_config.json");
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETTING_TEMPLATE_PATH = join(PACKAGE_ROOT, "data", "setting.example.json");
const PRICE_PATH = join(PACKAGE_ROOT, "data", "model-prices.csv");

export async function setup(): Promise<void> {
  console.log("\n配置 mori\n");

  const hasLlmConfig = existsSync(SETTING_PATH) && existsSync(ENV_PATH);
  const configureLlm =
    !hasLlmConfig ||
    (await confirm({
      message: "检测到已有 LLM 配置，是否重新配置？",
      default: false,
    }));

  if (configureLlm) {
    const answers = await promptLlmSetup();
    writeLlmConfig(answers);
    console.log(`\n✓ LLM 配置已写入 ${SETTING_PATH} 和 ${ENV_PATH}`);
  } else {
    console.log("✓ 保留已有 LLM 配置");
  }

  const hasLarkConfig = existsSync(LARK_PATH);
  const configureLark =
    !hasLarkConfig ||
    (await confirm({
      message: "检测到已有飞书配置，是否重新绑定？",
      default: false,
    }));

  if (configureLark) {
    const [{ runRegistrationWizard }, { saveLarkConfig }] = await Promise.all([
      import("./lark/setup.js"),
      import("./config.js"),
    ]);
    saveLarkConfig(await runRegistrationWizard());
    console.log(`✓ 飞书配置已写入 ${LARK_PATH}`);
  } else {
    console.log("✓ 保留已有飞书配置");
  }

  const start = await confirm({
    message: "配置完成，是否立即后台启动 mori？",
    default: true,
  });
  if (start) {
    const { startDaemon } = await import("./daemon.js");
    startDaemon();
  } else {
    console.log("\n之后可运行 `mori start` 启动。");
  }
}

async function promptLlmSetup(): Promise<SetupAnswers> {
  const api = await select<ApiProtocol>({
    message: "选择 API 协议",
    choices: PROTOCOLS.map((item) => ({
      name: item.label,
      value: item.api,
    })),
  });
  const protocol = PROTOCOLS.find((item) => item.api === api)!;

  while (true) {
    const baseUrl = await input({
      message: "Base URL",
      default: protocol.defaultBaseUrl,
      validate: validateBaseUrl,
    }).then(normalizeBaseUrl);
    const apiKey = await password({
      message: "API key",
      mask: "*",
      validate: (value) =>
        value.trim() && !/[\r\n]/.test(value)
          ? true
          : "API key 不能为空或包含换行",
    }).then((value) => value.trim());

    try {
      console.log("正在获取模型列表…");
      const models = await discoverModels(api, baseUrl, apiKey);
      if (models.length === 0) throw new Error("接口返回了空模型列表");
      const discovered = new Map(models.map((model) => [model.id, model]));
      return {
        api,
        baseUrl,
        apiKey,
        normalModel: await chooseModel("选择 normal 模型", models),
        strongModel: await chooseModel("选择 strong 模型", models),
        discovered,
      };
    } catch (err) {
      console.warn(`未能获取模型列表：${errorMessage(err)}`);
      const fallback = await select<"retry" | "manual">({
        message: "下一步",
        choices: [
          { name: "重新输入 Base URL 和 API key", value: "retry" },
          { name: "手动填写模型 ID", value: "manual" },
        ],
      });
      if (fallback === "retry") continue;
      return {
        api,
        baseUrl,
        apiKey,
        normalModel: await promptModelId("normal 模型 ID"),
        strongModel: await promptModelId("strong 模型 ID"),
        discovered: new Map(),
      };
    }
  }
}

async function chooseModel(
  message: string,
  models: DiscoveredModel[],
): Promise<string> {
  const choices = [
    ...models
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((model) => ({
        name:
          model.displayName && model.displayName !== model.id
            ? `${model.id} — ${model.displayName}`
            : model.id,
        value: model.id,
      })),
    { name: "手动输入…", value: MANUAL_MODEL },
  ];

  const selected = await search<string>({
    message,
    source: (term) => {
      const query = term?.trim().toLowerCase();
      if (!query) return choices;
      return choices.filter(
        (choice) =>
          choice.value === MANUAL_MODEL ||
          choice.name.toLowerCase().includes(query),
      );
    },
  });
  return selected === MANUAL_MODEL
    ? promptModelId(message.replace(/^选择 /, "") + " ID")
    : selected;
}

function promptModelId(message: string): Promise<string> {
  return input({
    message,
    validate: (value) => (value.trim() ? true : "模型 ID 不能为空"),
  }).then((value) => value.trim());
}

async function discoverModels(
  api: ApiProtocol,
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const url = modelListUrl(baseUrl);
  if (api === "anthropic-messages") url.searchParams.set("limit", "1000");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers:
        api === "anthropic-messages"
          ? {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            }
          : { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`模型接口返回 HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(body.data)) {
      throw new Error("模型接口响应缺少 data 数组");
    }

    return body.data.flatMap((raw) => {
      if (typeof raw.id !== "string" || !raw.id.trim()) return [];
      const capabilities = asRecord(raw.capabilities);
      return [
        {
          id: raw.id,
          displayName:
            typeof raw.display_name === "string"
              ? raw.display_name
              : undefined,
          contextWindow: positiveNumber(raw.max_input_tokens),
          maxTokens: positiveNumber(raw.max_tokens),
          reasoning: booleanField(capabilities.thinking),
          imageInput: booleanField(capabilities.image_input),
        },
      ];
    });
  } finally {
    clearTimeout(timeout);
  }
}

function writeLlmConfig(answers: SetupAnswers): void {
  const setting = JSON.parse(
    readFileSync(
      existsSync(SETTING_PATH) ? SETTING_PATH : SETTING_TEMPLATE_PATH,
      "utf-8",
    ),
  ) as Record<string, unknown>;
  const prices = readPrices();
  const modelIds = [...new Set([answers.normalModel, answers.strongModel])];
  const models = Object.fromEntries(
    modelIds.map((id) => [
      id,
      buildModelConfig(id, answers.discovered.get(id), prices),
    ]),
  );

  setting.llm = {
    providers: {
      main: {
        api: answers.api,
        baseUrl: answers.baseUrl,
        apiKeyEnv: "MORI_API_KEY",
        headers: {},
        ...(answers.api === "anthropic-messages"
          ? { request: { cacheRetention: "long" } }
          : {}),
        models,
      },
    },
    model_profiles: {
      normal: { provider: "main", model: answers.normalModel },
      strong: { provider: "main", model: answers.strongModel },
    },
    chat_types: defaultChatTypes(setting),
  };

  writePrivateFile(SETTING_PATH, JSON.stringify(setting, null, 2) + "\n");
  writePrivateFile(ENV_PATH, updateEnvApiKey(answers.apiKey));
}

function buildModelConfig(
  id: string,
  discovered: DiscoveredModel | undefined,
  prices: PriceRow[],
): Record<string, unknown> {
  const catalog = findCatalogMetadata(id);
  const price = matchPrice(id, prices);
  if (!price) {
    console.warn(`未找到 ${id} 的价格，成本暂按 0 计算`);
  }

  return {
    name: id,
    input: discovered?.imageInput ? ["text", "image"] : ["text"],
    reasoning: discovered?.reasoning ?? false,
    contextWindow:
      discovered?.contextWindow ?? catalog?.contextWindow ?? 200_000,
    maxTokens: discovered?.maxTokens ?? catalog?.maxTokens ?? 8_192,
    ...(price
      ? {
          cost: {
            input: price.input,
            output: price.output,
            cacheRead: price.cacheRead,
            cacheWrite: price.cacheWrite,
          },
        }
      : {}),
  };
}

function findCatalogMetadata(id: string): ModelMetadata | undefined {
  for (const provider of getProviders()) {
    const model = getModels(provider).find((item) => item.id === id);
    if (model) {
      return {
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      };
    }
  }
  return undefined;
}

function readPrices(): PriceRow[] {
  const [, ...lines] = readFileSync(PRICE_PATH, "utf-8")
    .trim()
    .split(/\r?\n/);
  return lines.map((line) => {
    const [pattern, , , input, output, cacheRead, cacheWrite] =
      line.split(",");
    return {
      pattern,
      input: Number(input),
      output: Number(output),
      cacheRead: Number(cacheRead),
      cacheWrite: Number(cacheWrite),
    };
  });
}

function matchPrice(id: string, rows: PriceRow[]): PriceRow | undefined {
  return rows
    .filter((row) => globMatches(row.pattern, id))
    .sort(
      (a, b) =>
        b.pattern.replaceAll("*", "").length -
        a.pattern.replaceAll("*", "").length,
    )[0];
}

function globMatches(pattern: string, value: string): boolean {
  const source = pattern
    .replaceAll(".", "-")
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value.replaceAll(".", "-"));
}

function defaultChatTypes(
  setting: Record<string, unknown>,
): Record<string, string> {
  const llm = asRecord(setting.llm);
  const existing = asRecord(llm.chat_types);
  if (Object.keys(existing).length > 0) {
    return existing as Record<string, string>;
  }
  return {
    dm: "normal",
    topic: "strong",
    thread: "strong",
    diary: "strong",
    distill: "normal",
    daily_memory: "strong",
    consolidation: "strong",
    review: "normal",
  };
}

function updateEnvApiKey(apiKey: string): string {
  const assignment = `MORI_API_KEY=${JSON.stringify(apiKey)}`;
  if (!existsSync(ENV_PATH)) {
    return `${assignment}\n\n# Web search（可选）\nTAVILY_API_KEY=\nBRAVE_API_KEY=\n`;
  }

  const lines = readFileSync(ENV_PATH, "utf-8").split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (!/^\s*MORI_API_KEY\s*=/.test(line)) return line;
    found = true;
    return assignment;
  });
  if (!found) updated.push(assignment);
  return updated.join("\n").replace(/\n*$/, "\n");
}

function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function modelListUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1")
    ? `${path}/models`
    : `${path}/v1/models`;
  return url;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function validateBaseUrl(value: string): true | string {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? true
      : "Base URL 必须使用 http 或 https";
  } catch {
    return "请输入有效的 Base URL";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function booleanField(value: unknown): boolean | undefined {
  const record = asRecord(value);
  return typeof record.supported === "boolean"
    ? record.supported
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return "请求超时";
  return err instanceof Error ? err.message : String(err);
}
