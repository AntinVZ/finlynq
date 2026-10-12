-- Payee Studio (P6.2, item 83) — "checked" mark for a directory entry.
--
--   payee_entities.reviewed_at  set when a person marks a suspicious entry
--                               (a short or meaningless name) as checked, so
--                               the "Перевірити" list doesn't show it again.
--                               NULL = not checked. Plain timestamp, no names.
-- Changes go through payee batches (30-day undo). Rows live in
-- payee_entities, already wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

ALTER TABLE payee_entities ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
