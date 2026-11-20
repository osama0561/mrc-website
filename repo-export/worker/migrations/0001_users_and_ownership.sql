-- Adds real per-person accounts and ownership scoping to the osama-crm D1 database.
-- Already applied to production. Safe to run again (IF NOT EXISTS / idempotent where possible).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,                                 -- login username (not a real phone number)
  role TEXT NOT NULL DEFAULT 'rep',           -- 'manager' | 'rep'
  password_hash TEXT NOT NULL,                -- PBKDF2-SHA256, hex
  password_salt TEXT NOT NULL,                -- random 16 bytes, hex
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uniq ON users (phone) WHERE phone IS NOT NULL AND phone != '';

-- owner_user_id is the real ownership link; `owner` (free text) stays as-is for legacy/
-- unassigned deals and is not backfilled.
ALTER TABLE deals ADD COLUMN owner_user_id TEXT;
ALTER TABLE activities ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS deals_owner_user ON deals (owner_user_id);
CREATE INDEX IF NOT EXISTS activities_user ON activities (user_id);
