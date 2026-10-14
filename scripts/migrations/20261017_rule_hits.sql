-- Payee Studio P8 (stage 10) — a hit counter on transaction rules. Each time
-- a rule fills a row (import, staged apply, "apply to uncategorized"), the
-- counter goes up and the time is kept, so the rules list and the merchant
-- page can show which rules work and which never fire.
--
-- Additive + idempotent. Existing rules start at 0 / NULL.

ALTER TABLE transaction_rules ADD COLUMN IF NOT EXISTS hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transaction_rules ADD COLUMN IF NOT EXISTS last_hit_at TIMESTAMPTZ;
