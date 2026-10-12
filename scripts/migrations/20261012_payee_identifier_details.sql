-- Payee Studio (P5f) — several cards / accounts per payee, with details.
--
--   label       e.g. "Mono black", "rent account" — user DEK encrypted (v1:)
--   bank        e.g. "monobank" — user DEK encrypted (v1:)
--   currency    ISO code of the account / card, optional (plain)
--   is_primary  the main requisite of its kind for the payee (plain)
--   is_active   false = closed / old; kept for history and search (plain)
-- Card numbers stay the last 4 digits only. Rows live in payee_identifiers,
-- already wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

ALTER TABLE payee_identifiers ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE payee_identifiers ADD COLUMN IF NOT EXISTS bank TEXT;
ALTER TABLE payee_identifiers ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE payee_identifiers ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payee_identifiers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
