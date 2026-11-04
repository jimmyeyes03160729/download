-- 網站登入帳密：id 固定為 1 的單列表，PRIMARY KEY 保證只能寫入一次
CREATE TABLE IF NOT EXISTS auth (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  username    TEXT    NOT NULL,
  salt        TEXT    NOT NULL,
  hash        TEXT    NOT NULL,
  iterations  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 登入失敗計數（依 IP；另有 key='*' 的全域計數，防止換 IP 暴力破解）
CREATE TABLE IF NOT EXISTS login_attempts (
  key           TEXT    PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,
  locked_until  INTEGER NOT NULL DEFAULT 0
);

-- 允許伺服器抓取的網域白名單與解析設定
--   adapter: telegram | discuz | rules | generic
--   rules:   adapter=rules 時的 CSS selector 設定（JSON）
--   cookie_enc: AES-GCM 加密後的登入 cookie（可為 NULL）
CREATE TABLE IF NOT EXISTS sites (
  domain      TEXT    PRIMARY KEY,
  adapter     TEXT    NOT NULL DEFAULT 'generic',
  rules       TEXT,
  cookie_enc  TEXT,
  note        TEXT,
  updated_at  INTEGER NOT NULL
);

-- 常用來源（首頁快捷按鈕）
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 已讀紀錄：每個來源各自記錄看過的項目
CREATE TABLE IF NOT EXISTS seen_items (
  source_key  TEXT    NOT NULL,
  item_key    TEXT    NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (source_key, item_key)
);

INSERT OR IGNORE INTO sites (domain, adapter, note, updated_at) VALUES
  ('t.me',     'telegram', 'Telegram 公開頻道預覽頁（t.me/s/頻道名）', 0),
  ('eyny.com', 'discuz',   'EYNY（Discuz!）。有瀏覽器安全檢查，伺服器多半抓不到，請用書籤小工具', 0);
