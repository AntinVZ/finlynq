-- loans.interest_category_id — which category a loan's interest is booked under
-- (2026-10-12, in-app feedback).
--
-- A loan payment stays a plain transfer into the loan account. The interest is
-- a separate expense transaction on that same account. The schedule works out
-- which periods have had their interest booked by READING THE LEDGER: every
-- transaction on the linked account in this category counts, however it got
-- there (typed in by hand, recorded by an assistant, or generated from the
-- schedule). No separate tracking table, so a hand-entered interest charge and
-- a generated one are the same thing.
--
-- Nullable: a loan has none until the user picks one. ON DELETE SET NULL: a
-- deleted category just un-sets it, it never blocks the delete.
--
-- The DROP removes `loan_interest_postings`, a tracking table from the first
-- cut of this feature. It was created on the dev database only (migration
-- `20261012_loan_interest_postings.sql`, deleted from the chain the same day)
-- and never reached production, where this statement is a no-op.
--
-- Idempotent.

DROP TABLE IF EXISTS loan_interest_postings;

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS interest_category_id INTEGER
  REFERENCES categories(id) ON DELETE SET NULL;
