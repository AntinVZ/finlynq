-- loan_interest_postings — which loan schedule periods have had their interest
-- booked into the loan's linked account (2026-10-12, in-app feedback).
--
-- A loan payment stays a plain transfer into the loan account. The interest is
-- a separate expense entry on that same account: it adds to what is owed, the
-- payment takes it off, and the balance falls by the principal only. This table
-- records "the interest for the payment due on <period_date> is transaction N"
-- so the schedule can show it as posted and never book it twice.
--
-- Keyed on the schedule row's DATE, not its period number: editing a loan's
-- start date or frequency renumbers periods, while a posting is about a
-- specific due date.
--
-- Both FKs cascade. Deleting the transaction in the Transactions list removes
-- the posting, so the period reads as un-posted again; deleting the loan drops
-- its postings and leaves the transactions alone.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS loan_interest_postings (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  period_date TEXT NOT NULL,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS loan_interest_postings_loan_period_uniq
  ON loan_interest_postings (loan_id, period_date);

CREATE INDEX IF NOT EXISTS idx_loan_interest_postings_user_id
  ON loan_interest_postings (user_id);

CREATE INDEX IF NOT EXISTS idx_loan_interest_postings_transaction_id
  ON loan_interest_postings (transaction_id);
