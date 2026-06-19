-- 基建消息日志：所有可被 reply 的聊天正文都按飞书 message_id 存一份。
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to TEXT,
  thread_id TEXT,
  root_id TEXT,
  knowledge_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_scope_time ON messages(chat_id, thread_id, created_at);

-- 记忆 episode：来源统一为单条消息或 scope 时间窗。
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  source_scope_id TEXT NOT NULL,
  source_message_id TEXT,
  source_started_at TEXT NOT NULL,
  source_ended_at TEXT NOT NULL,
  brief TEXT,
  analysis_json TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_source_scope ON episodes(source_scope_id);
CREATE INDEX IF NOT EXISTS idx_episodes_source_message ON episodes(source_message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  brief,
  analysis_json,
  content='episodes',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, brief, analysis_json) VALUES (new.rowid, new.brief, new.analysis_json);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, brief, analysis_json) VALUES('delete', old.rowid, old.brief, old.analysis_json);
END;
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, brief, analysis_json) VALUES('delete', old.rowid, old.brief, old.analysis_json);
  INSERT INTO episodes_fts(rowid, brief, analysis_json) VALUES (new.rowid, new.brief, new.analysis_json);
END;

-- 身份画像（单条 prose）
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 画像变更审计
CREATE TABLE IF NOT EXISTS profile_revisions (
  id TEXT PRIMARY KEY,
  old_content TEXT,
  new_content TEXT NOT NULL,
  source_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL
);

-- 工作集
CREATE TABLE IF NOT EXISTS working_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  thesis TEXT,
  current_questions_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  next_steps_json TEXT NOT NULL DEFAULT '[]',
  related_people_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_mentioned_at TEXT
);

-- 待审批工具调用
CREATE TABLE IF NOT EXISTS pending_tool_approvals (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  chat_id TEXT,
  message_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_tool_approvals_status ON pending_tool_approvals(status, created_at);

-- 周总结存档
CREATE TABLE IF NOT EXISTS weekly_summaries (
  id TEXT PRIMARY KEY,
  week_key TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 审计
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  scope_id TEXT,
  command TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  latency_ms INTEGER,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
