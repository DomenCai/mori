-- 基建消息日志：所有入口进入核心前转换成内部 message。
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to TEXT,
  thread_id TEXT,
  root_id TEXT,
  knowledge_path TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, occurred_at);

-- 记忆 episode：来源统一为单条消息或 conversation 时间窗。
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  source_conversation_id TEXT NOT NULL,
  source_message_id TEXT,
  source_started_at TEXT NOT NULL,
  source_ended_at TEXT NOT NULL,
  brief TEXT,
  analysis_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  digested_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_source_conversation ON episodes(source_conversation_id);
CREATE INDEX IF NOT EXISTS idx_episodes_source_message ON episodes(source_message_id);
CREATE INDEX IF NOT EXISTS idx_episodes_digested ON episodes(digested_run_id, occurred_at);

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

-- 当前主线：profile 与 storylines 之间的跨线综合层。
CREATE TABLE IF NOT EXISTS chapter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 当前主线变更审计
CREATE TABLE IF NOT EXISTS chapter_revisions (
  id TEXT PRIMARY KEY,
  old_content TEXT,
  new_content TEXT NOT NULL,
  source_storyline_ids_json TEXT NOT NULL DEFAULT '[]',
  source_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapter_revisions_run ON chapter_revisions(run_id);

-- 叙事线：episode 与 profile 之间的“正在展开什么”压缩层。
CREATE TABLE IF NOT EXISTS storylines (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  current_tension TEXT,
  emotional_arc TEXT,
  people_json TEXT NOT NULL DEFAULT '[]',
  evidence_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storylines_status ON storylines(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_storylines_last_active ON storylines(last_active_at);

-- 叙事线变更审计
CREATE TABLE IF NOT EXISTS storyline_revisions (
  id TEXT PRIMARY KEY,
  storyline_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storyline_revisions_storyline ON storyline_revisions(storyline_id, created_at);
CREATE INDEX IF NOT EXISTS idx_storyline_revisions_run ON storyline_revisions(run_id);

-- 每日记忆整理审计：dream、机械收缩、nudge 都归入同一条 run。
CREATE TABLE IF NOT EXISTS daily_memory_runs (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  input_episode_ids_json TEXT NOT NULL DEFAULT '[]',
  dream_summary TEXT,
  storyline_changes_json TEXT NOT NULL DEFAULT '[]',
  nudge_evaluated INTEGER NOT NULL DEFAULT 0,
  nudge_sent INTEGER NOT NULL DEFAULT 0,
  nudge_sent_at TEXT,
  nudge_text TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 周总结存档
CREATE TABLE IF NOT EXISTS weekly_summaries (
  id TEXT PRIMARY KEY,
  week_key TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  friend_note TEXT,
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
