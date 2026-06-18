-- 原文层（证据层，永不丢）
CREATE TABLE IF NOT EXISTS diary_entries (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  source TEXT NOT NULL,
  input_type TEXT NOT NULL,
  content TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  conversation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE VIRTUAL TABLE IF NOT EXISTS diary_entries_fts USING fts5(
  content,
  content='diary_entries',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS diary_ai AFTER INSERT ON diary_entries BEGIN
  INSERT INTO diary_entries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS diary_ad AFTER DELETE ON diary_entries BEGIN
  INSERT INTO diary_entries_fts(diary_entries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS diary_au AFTER UPDATE ON diary_entries BEGIN
  INSERT INTO diary_entries_fts(diary_entries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO diary_entries_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 单篇蒸馏
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  diary_entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  brief TEXT,
  analysis_json TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

-- ① 身份画像（单条 prose）
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
  source_diary_ids_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL
);

-- ② 工作集
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

-- 飞书 chat 注册
CREATE TABLE IF NOT EXISTS chat_registry (
  chat_id TEXT PRIMARY KEY,
  chat_type TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL
);

-- 周总结存档
CREATE TABLE IF NOT EXISTS weekly_summaries (
  id TEXT PRIMARY KEY,
  week_key TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 定时任务配置（骨架，v1 只填内置两条）
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  type TEXT NOT NULL,
  target_chat_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
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
