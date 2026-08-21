-- ---------------------------------------------------------------------------
-- Wellness World chatbot — SQLite schema
--
-- One file holds products (mirrored from WooCommerce), their embeddings, the
-- FAQ knowledge base, conversation sessions and analytics.
-- WooCommerce stays the system of record; everything here is a derived mirror
-- plus chatbot-owned state.
-- ---------------------------------------------------------------------------

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- --- Products --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  product_id                 INTEGER PRIMARY KEY,
  sku                        TEXT,
  name                       TEXT NOT NULL,
  name_ar                    TEXT,
  permalink                  TEXT,
  image_url                  TEXT,
  short_description          TEXT,
  description                TEXT,
  categories_json            TEXT NOT NULL DEFAULT '[]',
  tags_json                  TEXT NOT NULL DEFAULT '[]',
  brand                      TEXT,
  price                      REAL,
  regular_price              REAL,
  sale_price                 REAL,
  currency                   TEXT NOT NULL DEFAULT 'KWD',
  size                       TEXT,
  stock_status               TEXT NOT NULL DEFAULT 'instock',
  rating_average             REAL,
  rating_count               INTEGER NOT NULL DEFAULT 0,

  -- _wwc_* extension schema (spec §3.2)
  verification_status        TEXT NOT NULL DEFAULT 'unverified',
  ai_generated               INTEGER NOT NULL DEFAULT 0,
  ai_confidence              REAL,
  requires_pharmacist_review INTEGER NOT NULL DEFAULT 0,
  verified_by_pharmacist     INTEGER NOT NULL DEFAULT 0,

  concern_primary_json       TEXT NOT NULL DEFAULT '{"en":[],"ar":[]}',
  concern_secondary_json     TEXT NOT NULL DEFAULT '{"en":[],"ar":[]}',
  suitable_types_json        TEXT NOT NULL DEFAULT '{"en":[],"ar":[]}',
  not_ideal_for_json         TEXT NOT NULL DEFAULT '{"en":null,"ar":null}',
  key_ingredients_json       TEXT NOT NULL DEFAULT '[]',
  full_ingredients           TEXT,
  texture_finish_json        TEXT NOT NULL DEFAULT '{"en":null,"ar":null}',
  fragrance                  TEXT NOT NULL DEFAULT 'unspecified',
  fragrance_type             TEXT,
  alcohol                    TEXT NOT NULL DEFAULT 'unspecified',
  alcohol_type               TEXT,
  how_to_use_json            TEXT NOT NULL DEFAULT '{"en":null,"ar":null}',
  routine_step               TEXT,
  routine_time               TEXT,
  age_suitability            TEXT NOT NULL DEFAULT 'all',
  age_min                    INTEGER,
  age_max                    INTEGER,
  pregnancy_guidance_json    TEXT,
  warnings_json              TEXT NOT NULL DEFAULT '{"en":null,"ar":null}',
  complementary_products_json TEXT NOT NULL DEFAULT '[]',
  alternative_products_json  TEXT NOT NULL DEFAULT '[]',
  source_verification_date   TEXT,
  source_verification_note   TEXT,
  synonyms_en_json           TEXT NOT NULL DEFAULT '[]',
  synonyms_ar_json           TEXT NOT NULL DEFAULT '[]',

  updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_stock  ON products(stock_status);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(verification_status);
CREATE INDEX IF NOT EXISTS idx_products_conf   ON products(ai_confidence);

-- --- Label review workflow --------------------------------------------------
-- One row per AI labeling run. The draft never writes `verified` — only a human
-- action in the WP Label Review Queue can do that (spec §3.1, §3.3, §11).
CREATE TABLE IF NOT EXISTS label_drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL,
  category      TEXT,
  draft_json    TEXT NOT NULL,
  confidence    REAL,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,
  reviewed_by   TEXT,
  review_note   TEXT,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON label_drafts(status, confidence);
CREATE INDEX IF NOT EXISTS idx_drafts_product ON label_drafts(product_id);

-- Audit trail for anything safety- or policy-relevant (spec §8.6).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,   -- product | kb | settings | label_draft
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- --- Embeddings (vector index) ---------------------------------------------
-- Vectors are stored as Float32 BLOBs and scored with cosine similarity in
-- process. At a few thousand SKUs this is well under a millisecond and avoids
-- a native extension build on the host (spec §2 allows swapping this out).
CREATE TABLE IF NOT EXISTS embeddings (
  id          TEXT PRIMARY KEY,       -- "product:123" | "kb:7"
  kind        TEXT NOT NULL,          -- product | kb
  ref_id      INTEGER NOT NULL,
  content     TEXT NOT NULL,
  vector      BLOB NOT NULL,
  dimensions  INTEGER NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);

-- --- Knowledge base (FAQ / policy) -----------------------------------------
CREATE TABLE IF NOT EXISTS kb_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic       TEXT NOT NULL,
  question_en TEXT,
  question_ar TEXT,
  answer_en   TEXT,
  answer_ar   TEXT,
  approved    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_kb_approved ON kb_entries(approved);

-- --- Sessions ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  state_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at);

-- --- Analytics (spec §14) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  name        TEXT NOT NULL,
  payload_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  rating      TEXT NOT NULL,   -- up | down
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Business settings mirror (owned by WP, cached here) --------------------
CREATE TABLE IF NOT EXISTS business_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Bilingual reference table (spec §6.2) ---------------------------------
CREATE TABLE IF NOT EXISTS lexicon (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,   -- category | brand | ingredient | concern | product_type
  canonical     TEXT NOT NULL,
  name_en       TEXT,
  name_ar       TEXT,
  synonyms_en_json TEXT NOT NULL DEFAULT '[]',
  synonyms_ar_json TEXT NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lexicon_canonical ON lexicon(kind, canonical);
