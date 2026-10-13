-- loans.manual_schedule / loans.interest_overrides — a loan's own schedule
-- (2026-10-12, owner review).
--
-- Until now a loan's schedule was always calculated from principal, rate and
-- term or payment, and nothing in it could be changed. Two ways to say what
-- the lender really does:
--
--   interest_overrides  { "YYYY-MM-DD": amount }
--     Interest actually charged on specific payment dates. Replaces the
--     calculated figure for that row only; the payment is unchanged, so the
--     principal and every later balance follow.
--
--   manual_schedule     [ { "date", "payment", "interest" }, ... ]
--     A complete schedule supplied by the user (typed in, uploaded from the
--     CSV template, or sent by an assistant). When present it REPLACES the
--     calculation; principal and balance are derived from the rows.
--
-- Both are nullable and NULL means "calculated", so every existing loan is
-- unchanged. They live on the loan row on purpose: every reader that builds a
-- schedule already has the row in hand, and the pure `loanScheduleExtras`
-- turns it into calculator options the same way on every surface.
--
-- Additive + idempotent.

ALTER TABLE loans ADD COLUMN IF NOT EXISTS manual_schedule JSONB;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_overrides JSONB;
