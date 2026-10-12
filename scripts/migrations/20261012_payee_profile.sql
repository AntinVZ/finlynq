-- Payee Studio (P5c) — a merchant's website and logo.
--
--   website  https URL (normalized to https://host/path), user DEK encrypted
--            (v1: envelope) like the entity name.
--   logo     a small image as a data: URI (PNG / JPEG / WebP only — never SVG,
--            magic bytes checked, ≤ 20 KB decoded), user DEK encrypted.
-- Both are optional and found by the user or their AI client (the server never
-- looks anything up on the network). Rows live in payee_entities, which is
-- already wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

ALTER TABLE payee_entities ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE payee_entities ADD COLUMN IF NOT EXISTS logo TEXT;
