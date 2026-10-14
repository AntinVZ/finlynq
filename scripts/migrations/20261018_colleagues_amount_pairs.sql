-- Payee Studio P8 (stage 11) — data quality.
--
-- 1. «Колеги»: a built-in merchant type for colleagues — private persons you
--    pay or who pay you through work — kept apart from «Особи і ФОП». Users
--    whose merchant-type dictionary is already stored get it at the end of
--    their list (users still on the virtual starting set get it from the
--    code). Nothing is retyped.
-- 2. payee_pair_rejections: «Різні» answers in the duplicates-by-amount
--    queue — an HMAC of the two matching keys, never the names.
--
-- Additive + idempotent.

INSERT INTO payee_merchant_types (user_id, group_name, name, sort, code)
SELECT t.user_id, 'Колеги', 'Колеги', MAX(t.sort) + 1, 'colleagues'
FROM payee_merchant_types t
GROUP BY t.user_id
HAVING NOT COALESCE(BOOL_OR(COALESCE(t.code, '') = 'colleagues' OR (t.group_name = 'Колеги' AND t.name = 'Колеги')), false)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS payee_pair_rejections (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  pair_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS payee_pair_rejections_user_hash_idx ON payee_pair_rejections (user_id, pair_hash);
