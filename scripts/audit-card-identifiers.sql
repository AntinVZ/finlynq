-- Payee Studio P6.2 — audit: no stored card value longer than its last 4 digits.
--
-- Read only. Run with psql against the Finlynq database:
--   psql "$DATABASE_URL" -f scripts/audit-card-identifiers.sql
--
-- Card values are stored encrypted (`v1:<iv>:<ciphertext>:<tag>`, AES-256-GCM,
-- no padding), so the ciphertext length IS the plaintext length: a card's last
-- 4 digits decode to exactly 4 bytes. Nothing is decrypted and no value is
-- printed — only ids, kinds and lengths. Legacy plaintext rows (no `v1:`
-- prefix) are checked as text.

-- 1. Summary: every stored requisite by kind and plaintext length.
--    card_last4 must show ONLY plain_len = 4.
SELECT 'payee_identifiers' AS source, kind,
       CASE WHEN value LIKE 'v1:%' THEN length(decode(split_part(value, ':', 3), 'base64')) ELSE length(value) END AS plain_len,
       (value LIKE 'v1:%') AS encrypted,
       count(*) AS rows
FROM payee_identifiers
GROUP BY 1, 2, 3, 4
UNION ALL
SELECT 'payee_own_accounts', 'card_last4',
       CASE WHEN card_last4 LIKE 'v1:%' THEN length(decode(split_part(card_last4, ':', 3), 'base64')) ELSE length(card_last4) END,
       (card_last4 LIKE 'v1:%'),
       count(*)
FROM payee_own_accounts
WHERE card_last4 IS NOT NULL
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3;

-- 2. Violations: card values that are not exactly 4 digits (expected: 0 rows).
SELECT 'payee_identifiers' AS source, id, user_id,
       CASE WHEN value LIKE 'v1:%' THEN length(decode(split_part(value, ':', 3), 'base64')) ELSE length(value) END AS plain_len
FROM payee_identifiers
WHERE kind = 'card_last4'
  AND (CASE WHEN value LIKE 'v1:%' THEN length(decode(split_part(value, ':', 3), 'base64')) <> 4 ELSE value !~ '^[0-9]{4}$' END)
UNION ALL
SELECT 'payee_own_accounts', id, user_id,
       CASE WHEN card_last4 LIKE 'v1:%' THEN length(decode(split_part(card_last4, ':', 3), 'base64')) ELSE length(card_last4) END
FROM payee_own_accounts
WHERE card_last4 IS NOT NULL
  AND (CASE WHEN card_last4 LIKE 'v1:%' THEN length(decode(split_part(card_last4, ':', 3), 'base64')) <> 4 ELSE card_last4 !~ '^[0-9]{4}$' END);

-- 3. Legacy plaintext requisites of any kind holding 12+ digits in a row (expected: 0 rows).
SELECT id, user_id, kind, length(value) AS plain_len
FROM payee_identifiers
WHERE value NOT LIKE 'v1:%' AND regexp_replace(value, '[\s-]', '', 'g') ~ '[0-9]{12,}' AND kind <> 'iban';
