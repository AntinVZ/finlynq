-- Payee Studio (P2) — the payee directory and its change journal.
--
--   payee_entities     one counterparty: canonical name, type, note, an
--                      optional default category (a HINT only — never applied
--                      to transactions by itself).
--   payee_aliases      spellings / patterns that resolve to an entity:
--                      mode exact (matching-key equality: letter case,
--                      apostrophes, Latin/Cyrillic transliteration and
--                      card-terminal noise ignored), contains, or regex.
--                      `key_hash` is an HMAC of the matching key (user DEK),
--                      never the plaintext key.
--   payee_identifiers  IBAN / tax id / EDRPOU / card last 4 / crypto wallet.
--                      Card numbers are stored as the last 4 digits only.
--   payee_batches      one row per directory change or payee rewrite; the
--                      encrypted `undo_data` lets the change be rolled back for
--                      30 days (`expires_at`). `summary` holds counts only.
--
-- Encrypted at rest with the user's DEK (v1: envelope), like transactions.payee:
-- payee_entities.name / note, payee_aliases.pattern, payee_identifiers.value,
-- payee_batches.undo_data. Searching them happens in memory after decryption.
-- Every table carries user_id; all are wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS payee_entities (
  id                   SERIAL PRIMARY KEY,
  user_id              TEXT NOT NULL,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL DEFAULT 'other',
  note                 TEXT,
  default_category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payee_entities_user_idx ON payee_entities (user_id);

CREATE TABLE IF NOT EXISTS payee_aliases (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  entity_id   INTEGER NOT NULL REFERENCES payee_entities(id) ON DELETE CASCADE,
  pattern     TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'exact',
  key_hash    TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payee_aliases_entity_idx ON payee_aliases (entity_id);
CREATE INDEX IF NOT EXISTS payee_aliases_user_key_idx ON payee_aliases (user_id, key_hash);

CREATE TABLE IF NOT EXISTS payee_identifiers (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  entity_id   INTEGER NOT NULL REFERENCES payee_entities(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payee_identifiers_entity_idx ON payee_identifiers (entity_id);
CREATE INDEX IF NOT EXISTS payee_identifiers_user_idx ON payee_identifiers (user_id);

CREATE TABLE IF NOT EXISTS payee_batches (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'web',
  summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_ids  INTEGER[] NOT NULL DEFAULT '{}',
  undo_data   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  undone_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payee_batches_user_created_idx ON payee_batches (user_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payee_entities_type_check') THEN
    ALTER TABLE payee_entities
      ADD CONSTRAINT payee_entities_type_check CHECK (type IN ('retail', 'service', 'bank', 'government', 'person', 'sole_proprietor', 'company', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payee_aliases_mode_check') THEN
    ALTER TABLE payee_aliases
      ADD CONSTRAINT payee_aliases_mode_check CHECK (mode IN ('exact', 'contains', 'regex'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payee_identifiers_kind_check') THEN
    ALTER TABLE payee_identifiers
      ADD CONSTRAINT payee_identifiers_kind_check CHECK (kind IN ('iban', 'tax_id', 'edrpou', 'card_last4', 'crypto_wallet'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payee_batches_actor_check') THEN
    ALTER TABLE payee_batches
      ADD CONSTRAINT payee_batches_actor_check CHECK (actor IN ('web', 'mcp', 'autopilot', 'import'));
  END IF;
END $$;
