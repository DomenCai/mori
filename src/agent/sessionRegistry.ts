// agent_sessions 与 message_session_entries 的所有 SQL 集中在这里。
// 只服务交互式 chat type（dm / topic / thread / diary）。
import type Database from "better-sqlite3";
import { nowISO } from "../utils.js";
import type { AgentChatType } from "../config.js";

export interface AgentSessionRow {
  id: string;
  session_path: string;
  cwd: string;
  scope_id: string;
  chat_type: AgentChatType;
  profile_name: string;
  model_id: string;
  active_tool_names_json: string;
  status: "open" | "closed";
  started_at: string;
  last_activity_at: string;
  closed_at: string | null;
  segment_started_at: string | null;
  segment_ended_at: string | null;
}

export interface CreateAgentSessionInput {
  id: string;
  sessionPath: string;
  cwd: string;
  scopeId: string;
  chatType: AgentChatType;
  profileName: string;
  modelId: string;
  activeToolNames: string[];
}

export class SessionRegistry {
  constructor(private db: Database.Database) {}

  create(input: CreateAgentSessionInput): AgentSessionRow {
    const now = nowISO();
    this.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, session_path, cwd, scope_id, chat_type, profile_name, model_id,
            active_tool_names_json, status, started_at, last_activity_at,
            closed_at, segment_started_at, segment_ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        input.id,
        input.sessionPath,
        input.cwd,
        input.scopeId,
        input.chatType,
        input.profileName,
        input.modelId,
        JSON.stringify(input.activeToolNames),
        now,
        now,
      );
    return this.get(input.id)!;
  }

  get(id: string): AgentSessionRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM agent_sessions WHERE id = ?")
        .get(id) as AgentSessionRow | undefined) ?? null
    );
  }

  /**
   * 找当前 scope 的 unclosed session（status = 'open'）。
   * partial unique index 保证最多一条；为防御异常状态仍按 last_activity_at 排序取第一条。
   */
  findUnclosedForScope(scopeId: string): AgentSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM agent_sessions
           WHERE scope_id = ? AND status = 'open'
           ORDER BY last_activity_at DESC, id ASC
           LIMIT 1`,
        )
        .get(scopeId) as AgentSessionRow | undefined) ?? null
    );
  }

  findByMessageId(messageId: string): AgentSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT s.* FROM agent_sessions s
           JOIN message_session_entries m ON m.session_id = s.id
           WHERE m.message_id = ?`,
        )
        .get(messageId) as AgentSessionRow | undefined) ?? null
    );
  }

  findOtherOpenSessions(scopeId: string, exceptId: string): AgentSessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_sessions
         WHERE scope_id = ? AND status = 'open' AND id != ?
         ORDER BY last_activity_at DESC, id ASC`,
      )
      .all(scopeId, exceptId) as AgentSessionRow[];
  }

  markClosed(id: string): void {
    const now = nowISO();
    this.db
      .prepare(
        "UPDATE agent_sessions SET status = 'closed', closed_at = ? WHERE id = ?",
      )
      .run(now, id);
  }

  /**
   * 单事务关闭同 scope 其它 open session，并把 target reopen。
   * SQLite partial unique index 是 immediate constraint，必须先关 others 再开 target。
   *
   * `resetSegment` 由调用方按 target 原状态决定：
   *   - target 原本 closed（典型 reply-target 恢复）：true，开启新 segment 窗口；
   *   - target 原本 open（reply-target 恰好命中当前 unclosed session）：false，
   *     幂等写入，保留尚未蒸馏的 segment 窗口。
   */
  reopenWithExclusivity(
    targetId: string,
    scopeId: string,
    opts: { resetSegment: boolean },
  ): void {
    const now = nowISO();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_sessions
             SET status = 'closed', closed_at = ?
           WHERE scope_id = ? AND status = 'open' AND id != ?`,
        )
        .run(now, scopeId, targetId);
      if (opts.resetSegment) {
        this.db
          .prepare(
            `UPDATE agent_sessions
               SET status = 'open',
                   closed_at = NULL,
                   segment_started_at = NULL,
                   segment_ended_at = NULL,
                   last_activity_at = ?
             WHERE id = ?`,
          )
          .run(now, targetId);
      } else {
        this.db
          .prepare(
            `UPDATE agent_sessions
               SET last_activity_at = ?
             WHERE id = ?`,
          )
          .run(now, targetId);
      }
    });
    tx();
  }

  /** 进程重启场景下原 unclosed session 继续使用，只刷活动时间，不清 segment。 */
  touchActivity(id: string, activityAt: string): void {
    this.db
      .prepare(
        "UPDATE agent_sessions SET last_activity_at = ? WHERE id = ?",
      )
      .run(activityAt, id);
  }

  /** 更新 segment window：每条用户消息扩到 endedAt；首条用户消息设 startedAt。 */
  updateSegmentWindow(id: string, occurredAt: string): void {
    this.db
      .prepare(
        `UPDATE agent_sessions
           SET segment_started_at = COALESCE(segment_started_at, ?),
               segment_ended_at = ?,
               last_activity_at = ?
         WHERE id = ?`,
      )
      .run(occurredAt, occurredAt, occurredAt, id);
  }

  recordMessageEntry(opts: {
    messageId: string;
    sessionId: string;
    entryId?: string | null;
    scopeId: string;
    role: "user" | "assistant";
    occurredAt: string;
  }): void {
    const now = nowISO();
    this.db
      .prepare(
        `INSERT INTO message_session_entries
           (message_id, session_id, entry_id, scope_id, role, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           session_id = excluded.session_id,
           entry_id = excluded.entry_id,
           scope_id = excluded.scope_id,
           role = excluded.role,
           occurred_at = excluded.occurred_at`,
      )
      .run(
        opts.messageId,
        opts.sessionId,
        opts.entryId ?? null,
        opts.scopeId,
        opts.role,
        opts.occurredAt,
        now,
      );
  }
}
