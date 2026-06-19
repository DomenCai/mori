import type Database from "better-sqlite3";
import { genId, nowISO } from "../utils.js";
import type {
  MergeWorkingItemsData,
  UpdateWorkingItemData,
} from "../agent/schemas.js";
import type { MemoryService } from "./service.js";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "applied"
  | "failed";

export interface PendingToolApproval {
  id: string;
  tool_name: string;
  payload_json: string;
  status: ApprovalStatus;
  chat_id: string | null;
  message_id: string | null;
  run_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface WorkingApprovalPayload {
  tool_name: "update_working_item" | "merge_working_items" | "batch_update_working_items";
  data: UpdateWorkingItemData | MergeWorkingItemsData | BatchUpdateWorkingItemsData;
  reason: string;
}

export interface BatchUpdateWorkingItemsData {
  updates: UpdateWorkingItemData[];
}

export class ApprovalService {
  constructor(private db: Database.Database) {}

  createPending(opts: {
    toolName: WorkingApprovalPayload["tool_name"];
    payload: WorkingApprovalPayload;
    chatId?: string | null;
    messageId?: string | null;
    runId?: string | null;
  }): string {
    const id = genId("appr");
    this.db
      .prepare(
        `INSERT INTO pending_tool_approvals (id, tool_name, payload_json, status, chat_id, message_id, run_id, created_at, resolved_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        opts.toolName,
        JSON.stringify(opts.payload),
        opts.chatId ?? null,
        opts.messageId ?? null,
        opts.runId ?? null,
        nowISO(),
      );
    return id;
  }

  get(id: string): PendingToolApproval | null {
    return (
      (this.db
        .prepare("SELECT * FROM pending_tool_approvals WHERE id = ?")
        .get(id) as PendingToolApproval | undefined) ?? null
    );
  }

  attachMessage(id: string, chatId: string, messageId: string): void {
    this.db
      .prepare(
        "UPDATE pending_tool_approvals SET chat_id = coalesce(chat_id, ?), message_id = ? WHERE id = ?",
      )
      .run(chatId, messageId, id);
  }

  reject(id: string): PendingToolApproval {
    const approval = this.requirePending(id);
    this.db
      .prepare(
        "UPDATE pending_tool_approvals SET status = 'rejected', resolved_at = ? WHERE id = ?",
      )
      .run(nowISO(), id);
    return { ...approval, status: "rejected", resolved_at: nowISO() };
  }

  apply(id: string, memoryService: MemoryService): PendingToolApproval {
    const tx = this.db.transaction(() => {
      const approval = this.requirePending(id);
      this.db
        .prepare(
          "UPDATE pending_tool_approvals SET status = 'approved', resolved_at = ? WHERE id = ?",
        )
        .run(nowISO(), id);

      const payload = JSON.parse(approval.payload_json) as WorkingApprovalPayload;
      if (payload.tool_name === "merge_working_items") {
        memoryService.mergeWorkingItems(payload.data as MergeWorkingItemsData);
      } else if (payload.tool_name === "batch_update_working_items") {
        const batch = payload.data as BatchUpdateWorkingItemsData;
        for (const update of batch.updates) {
          memoryService.updateWorkingItem(update);
        }
      } else if (payload.tool_name === "update_working_item") {
        memoryService.updateWorkingItem(payload.data as UpdateWorkingItemData);
      } else {
        throw new Error(`不支持的审批工具：${payload.tool_name}`);
      }
      this.db
        .prepare(
          "UPDATE pending_tool_approvals SET status = 'applied', resolved_at = ? WHERE id = ?",
        )
        .run(nowISO(), id);

      return this.get(id)!;
    });
    try {
      return tx();
    } catch (err) {
      this.markFailedIfStillPending(id);
      throw err;
    }
  }

  parsePayload(approval: PendingToolApproval): WorkingApprovalPayload {
    return JSON.parse(approval.payload_json) as WorkingApprovalPayload;
  }

  private requirePending(id: string): PendingToolApproval {
    const approval = this.get(id);
    if (!approval) throw new Error(`审批不存在：${id}`);
    if (approval.status !== "pending") {
      throw new Error(`审批 ${id} 当前状态为 ${approval.status}，不能处理`);
    }

    const ageMs = Date.now() - new Date(approval.created_at).getTime();
    if (ageMs > 7 * 86_400_000) {
      this.db
        .prepare(
          "UPDATE pending_tool_approvals SET status = 'expired', resolved_at = ? WHERE id = ?",
        )
        .run(nowISO(), id);
      throw new Error(`审批 ${id} 已超过 7 天并过期`);
    }
    return approval;
  }

  private markFailedIfStillPending(id: string): void {
    const approval = this.get(id);
    if (approval?.status !== "pending") return;
    this.db
      .prepare(
        "UPDATE pending_tool_approvals SET status = 'failed', resolved_at = ? WHERE id = ?",
      )
      .run(nowISO(), id);
  }
}
