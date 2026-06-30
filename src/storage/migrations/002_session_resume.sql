-- Agent session 恢复索引：进程重启或冷启动回复时定位 JSONL transcript 的权威来源。
-- 只记录交互式 chat type（dm / topic / thread / diary），内部一次性 scope
-- （schedule / distill / daily_memory / consolidation / review）不进入。
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  session_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  active_tool_names_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  segment_started_at TEXT,
  segment_ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_scope_status
  ON agent_sessions(scope_id, status, last_activity_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_open_per_scope
  ON agent_sessions(scope_id)
  WHERE status = 'open';

-- 飞书 message -> agent session 关联：reply-target 冷启动恢复的索引。
CREATE TABLE IF NOT EXISTS message_session_entries (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  entry_id TEXT,
  scope_id TEXT NOT NULL,
  role TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_session_entries_session
  ON message_session_entries(session_id, occurred_at);
