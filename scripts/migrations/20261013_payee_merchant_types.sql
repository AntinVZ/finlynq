-- Payee Studio (P6, B26) — merchant types: WHAT a merchant is, as one
-- two-level value per directory entry (group → position, e.g.
-- "Кафе, ресторани, бари" → "Ресторани").
--
--   payee_merchant_types  the user's editable dictionary: group_name, name
--                         (position), sort, an OPTIONAL default category
--                         (not linked by default). A plain taxonomy, stored
--                         in plaintext like payee_entities.type. Until a user
--                         has rows, the app shows a built-in starting set and
--                         writes it on the first change that needs a row.
--   payee_entities.merchant_type_id
--                         the entry's type; NULL = no type (every existing
--                         entry starts without one). The existing `type` enum
--                         (retail | service | … ) is unchanged.
--
-- Changes go through payee batches (30-day undo). Wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS payee_merchant_types (
  id                   SERIAL PRIMARY KEY,
  user_id              TEXT NOT NULL,
  group_name           TEXT NOT NULL,
  name                 TEXT NOT NULL,
  sort                 INTEGER NOT NULL DEFAULT 0,
  default_category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payee_merchant_types_user_group_name_idx ON payee_merchant_types (user_id, group_name, name);

ALTER TABLE payee_entities ADD COLUMN IF NOT EXISTS merchant_type_id INTEGER REFERENCES payee_merchant_types(id) ON DELETE SET NULL;
