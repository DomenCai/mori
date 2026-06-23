import type { AgentHarness } from "@earendil-works/pi-agent-core";

/**
 * 通用工具调用拦截器。
 *
 * 工具「定义」是缓存前缀的一部分，一旦增删就会让整段 prompt 缓存失效
 * （cacheRead 归零、全量 cacheWrite 重算）。所以会话存活期间工具集保持恒定，
 * 要限制「本轮能调哪些工具」不靠 setActiveTools 摘工具，而靠这里在调用发生时
 * 按当前禁用集硬拦截——翻转禁用集只是内存赋值，碰不到缓存前缀。
 */
export interface ToolGuard {
  /** 设定本轮禁止调用的工具，替换上一轮。 */
  block(names: string[], reason: string): void;
  /** 恢复到创建时设定的默认禁用集。 */
  reset(): void;
}

export function installToolGuard(
  harness: AgentHarness,
  defaultBlocked: string[] = [],
  defaultReason = "",
): ToolGuard {
  const base = new Set(defaultBlocked);
  let blocked = new Set(base);
  let reason = defaultReason;
  harness.on("tool_call", (event) =>
    blocked.has(event.toolName) ? { block: true, reason } : undefined,
  );
  return {
    block(names, r) {
      blocked = new Set(names);
      reason = r;
    },
    reset() {
      blocked = new Set(base);
      reason = defaultReason;
    },
  };
}
