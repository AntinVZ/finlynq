-- Payee Studio P8 (stage 6, i18n) — stable keys for the built-in merchant
-- types. `code` (cafe, restaurant, fuel, pharmacy, …) stays with a built-in
-- position when the user renames it, so type-word hints, MCC suggestions and
-- the persons rule keep finding it, and the interface can show the built-in
-- name in the interface language. The user's own types have no code.
--
-- Existing names are kept as they are. Rows that still carry a starting-set
-- (Ukrainian) group + name get their code here.
--
-- Additive + idempotent.

ALTER TABLE payee_merchant_types ADD COLUMN IF NOT EXISTS code TEXT;

UPDATE payee_merchant_types AS t
SET code = d.code
FROM (VALUES
  ('Кафе, ресторани, бари', 'Кафе', 'cafe'),
  ('Кафе, ресторани, бари', 'Ресторани', 'restaurant'),
  ('Кафе, ресторани, бари', 'Бари', 'bar'),
  ('Готелі', 'Готелі', 'hotel'),
  ('Пальне (АЗС)', 'Пальне (АЗС)', 'fuel'),
  ('Супермаркети і продукти', 'Супермаркети і продукти', 'grocery'),
  ('Аптеки', 'Аптеки', 'pharmacy'),
  ('Транспорт і таксі', 'Транспорт і таксі', 'transport'),
  ('Онлайн-сервіси та підписки', 'Онлайн-сервіси та підписки', 'online_services'),
  ('Маркетплейси', 'Маркетплейси', 'marketplace'),
  ('Одяг і взуття', 'Одяг і взуття', 'clothing'),
  ('Побутова техніка', 'Побутова техніка', 'electronics'),
  ('Ремонт і будівництво', 'Ремонт і будівництво', 'home_improvement'),
  ('Комунальні й зв''язок', 'Комунальні й зв''язок', 'utilities'),
  ('Банки і комісії', 'Банки і комісії', 'bank_fees'),
  ('Банківські операції', 'Банківські операції', 'bank_operations'),
  ('Держава і податки', 'Держава і податки', 'government'),
  ('Освіта і медицина', 'Освіта і медицина', 'education_health'),
  ('Розваги', 'Розваги', 'entertainment'),
  ('Особи і ФОП', 'Особи і ФОП', 'persons'),
  ('Інше', 'Інше', 'other')
) AS d(group_name, name, code)
WHERE t.code IS NULL AND t.group_name = d.group_name AND t.name = d.name;

CREATE INDEX IF NOT EXISTS payee_merchant_types_user_code_idx ON payee_merchant_types (user_id, code) WHERE code IS NOT NULL;
