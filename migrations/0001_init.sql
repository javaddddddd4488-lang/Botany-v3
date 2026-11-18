-- Botanical database schema for Cloudflare D1 (SQLite)

-- One row per imported workbook. Only one dataset is active at a time;
-- a new import is staged as 'pending' and swapped in atomically on finish.
CREATE TABLE datasets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name    TEXT    NOT NULL,
  sheet_name   TEXT    NOT NULL,
  columns      TEXT    NOT NULL,                -- JSON array of column names
  row_count    INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','retired')),
  is_active    INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  created_at   INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE UNIQUE INDEX one_active_dataset ON datasets(is_active) WHERE is_active = 1;

CREATE TABLE records (
  id          INTEGER PRIMARY KEY,
  dataset_id  INTEGER NOT NULL REFERENCES datasets(id),
  row_num     INTEGER NOT NULL,
  data        TEXT    NOT NULL,                 -- JSON array of cell values, aligned with datasets.columns
  search_text TEXT    NOT NULL                  -- normalized text used for search
);
CREATE UNIQUE INDEX records_dataset_row ON records(dataset_id, row_num);

-- Full-text index (rowid = records.id)
CREATE VIRTUAL TABLE records_fts USING fts5(search_text, tokenize = 'unicode61 remove_diacritics 2');

-- Server-side sessions (only a SHA-256 hash of the token is stored)
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('member','admin')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Failed login attempts, for brute-force throttling
CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX login_attempts_ip_at ON login_attempts(ip, at);
