// harness 事件 → AgentCardState 的累积与格式化。
// 与 cards.ts（state → 飞书卡片渲染）分工：这里管"如何从事件构建状态"，
// 渲染层换成别的（如未来 CLI）时，这部分逻辑仍可复用。
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import { renderAgentCard, type AgentCardState } from "./cards.js";

type ToolExecutionStartEvent = Extract<
  AgentHarnessEvent,
  { type: "tool_execution_start" }
>;

type ToolExecutionEndEvent = Extract<
  AgentHarnessEvent,
  { type: "tool_execution_end" }
>;

type AgentCardController = {
  update(next: object | ((current: object) => object)): Promise<void>;
};

export async function updateAgentCard(
  ctrl: AgentCardController,
  state: AgentCardState,
  opts: { yieldForPatch?: boolean } = {},
): Promise<void> {
  await ctrl.update(renderAgentCard(state));
  if (opts.yieldForPatch) {
    // Card stream patches are scheduled on a timer; yielding lets fast tools
    // still publish distinct running and finished snapshots.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function appendCardText(state: AgentCardState, delta: string): void {
  const last = state.blocks.at(-1);
  if (last?.type === "text") {
    last.content += delta;
  } else {
    state.blocks.push({ type: "text", content: delta });
  }
  state.footer = "streaming";
}

export function startCardTool(
  state: AgentCardState,
  event: ToolExecutionStartEvent,
): void {
  state.blocks.push({
    type: "tool",
    id: event.toolCallId,
    name: event.toolName,
    args: event.args,
    status: "running",
  });
  state.footer = "tool_running";
}

export function finishCardTool(
  state: AgentCardState,
  event: ToolExecutionEndEvent,
): void {
  const existing = state.blocks.find(
    (block) => block.type === "tool" && block.id === event.toolCallId,
  );
  if (existing?.type === "tool") {
    existing.status = event.isError ? "error" : "done";
    existing.output = formatToolResult(event.result);
  } else {
    state.blocks.push({
      type: "tool",
      id: event.toolCallId,
      name: event.toolName,
      args: {},
      status: event.isError ? "error" : "done",
      output: formatToolResult(event.result),
    });
  }
  const hasRunningTool = state.blocks.some(
    (block) => block.type === "tool" && block.status === "running",
  );
  state.footer = hasRunningTool ? "tool_running" : "thinking";
}

function formatToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return stringifyUnknown(result);
  const record = result as { content?: unknown; details?: unknown };
  return [formatToolContent(record.content), formatToolDetails(record.details)]
    .filter(Boolean)
    .join("\n");
}

function formatToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return stringifyUnknown(item);
      const record = item as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      if (record.type === "image" && typeof record.mimeType === "string") {
        return `[image:${record.mimeType}]`;
      }
      return stringifyUnknown(item);
    })
    .filter(Boolean)
    .join("\n");
}

function formatToolDetails(details: unknown): string {
  if (details === undefined || details === null) return "";
  if (
    typeof details === "object" &&
    !Array.isArray(details) &&
    Object.keys(details).length === 0
  ) {
    return "";
  }
  return `details: ${stringifyUnknown(details)}`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function extractTotalTokens(message: unknown): number {
  const msg = message as { role?: string; usage?: { totalTokens?: number } };
  if (msg.role === "assistant" && typeof msg.usage?.totalTokens === "number") {
    return msg.usage.totalTokens;
  }
  return 0;
}

export function getAssistantError(message: unknown): string | null {
  const candidate = message as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (candidate.role !== "assistant") return null;
  if (typeof candidate.errorMessage === "string" && candidate.errorMessage) {
    return candidate.errorMessage;
  }
  if (candidate.stopReason === "error") return "模型调用失败";
  if (candidate.stopReason === "aborted") return "模型调用已中止";
  return null;
}
