-- loans.interest_method / loans.interest_amount — how a loan's interest is
-- worked out (2026-10-12, in-app feedback).
--
-- Until now interest was always the loan's annual rate applied to the balance
-- still owed. Lenders also quote loans two other ways, and users arrive with
-- those numbers rather than a rate:
--
--   'rate'   (default) annual_rate on the remaining balance. The existing
--            behaviour; interest_amount is unused.
--   'flat'   the same interest with EVERY payment. interest_amount is that
--            per-payment figure (for example 87 on each of 60 payments of 587).
--            This is how such loans are advertised, not how interest accrues,
--            so the schedule also reports the comparable yearly rate.
--   'total'  interest_amount is the interest over the WHOLE loan. The payment
--            is level and the total is spread the standard way: the rate that
--            produces exactly that total is solved for, then applied to the
--            remaining balance, so more interest falls early and less late.
--
-- Every existing loan is 'rate' and unchanged. Read through
-- `loanScheduleExtras`, like the loan's other schedule settings.
--
-- Idempotent (the constraint is dropped first so a re-run cannot fail).

ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_method TEXT NOT NULL DEFAULT 'rate';
ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_amount DOUBLE PRECISION;

ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_interest_method_check;
ALTER TABLE loans
  ADD CONSTRAINT loans_interest_method_check CHECK (interest_method IN ('rate', 'flat', 'total'));
