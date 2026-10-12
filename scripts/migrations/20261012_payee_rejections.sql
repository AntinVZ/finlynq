-- Payee Studio (P5b) — remembered "different payee" decisions.
--
-- When a person answers "Different payee" to a look-alike suggestion
-- (a spelling that looks like a directory entry), the pair is remembered so
-- it is not suggested again. `key_hash` is an HMAC (user DEK) of the
-- spelling's matching key — never the plaintext spelling or key. Deleting the
-- entity drops its rejections. Cancelling a rejection deletes the row.
-- Wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS payee_rejections (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  entity_id   INTEGER NOT NULL REFERENCES payee_entities(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payee_rejections_user_key_entity_idx ON payee_rejections (user_id, key_hash, entity_id);
