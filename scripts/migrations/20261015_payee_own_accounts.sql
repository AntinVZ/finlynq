-- Payee Studio (P6.2, item 76 / B27) — "Мої рахунки і картки": the user's
-- own accounts and cards, a plain reference list (nothing is imported from a
-- bank).
--
--   iban        the account's IBAN — user DEK encrypted (v1:)
--   card_last4  the card's LAST 4 digits only — user DEK encrypted (v1:).
--               A full card number is refused by the app and never stored.
--   bank, label user DEK encrypted (v1:)
--   currency    ISO code, optional (plain)
--   owner       me | spouse | business (plain)
-- At least one of iban / card_last4 is set. Changes go through payee
-- batches (30-day undo). Wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS payee_own_accounts (
  id          SERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  iban        TEXT,
  card_last4  TEXT,
  bank        TEXT,
  label       TEXT,
  currency    TEXT,
  owner       TEXT NOT NULL DEFAULT 'me',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payee_own_accounts_user_idx ON payee_own_accounts (user_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payee_own_accounts_owner_check') THEN
    ALTER TABLE payee_own_accounts
      ADD CONSTRAINT payee_own_accounts_owner_check CHECK (owner IN ('me', 'spouse', 'business'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payee_own_accounts_value_check') THEN
    ALTER TABLE payee_own_accounts
      ADD CONSTRAINT payee_own_accounts_value_check CHECK (iban IS NOT NULL OR card_last4 IS NOT NULL);
  END IF;
END $$;
