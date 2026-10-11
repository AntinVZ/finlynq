-- Payee Studio (P3) — AI proposals awaiting a human decision.
--
-- An AI client (Claude over MCP) reviews payees and submits proposals:
-- canonical name, type, aliases, identifiers, a reason and a confidence.
-- They are stored here as DRAFTS and change nothing until a person approves
-- them (the approval runs as one payee batch, undoable for 30 days; undoing it
-- puts the proposals back to draft). The server itself never calls a model.
--
-- `payload` is the proposal JSON, encrypted with the user's DEK (v1:
-- envelope) — it carries payee names. `confidence`, `status` and the
-- `needs_decision` flag are plain so the review page can sort and filter.
-- Card numbers in a proposal are cut to the last 4 digits before storage.
-- Wiped in deleteAllUserDataTx.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS payee_proposals (
  id              SERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 0,
  needs_decision  BOOLEAN NOT NULL DEFAULT false,
  payload         TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'mcp',
  batch_id        INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payee_proposals_user_status_idx ON payee_proposals (user_id, status, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payee_proposals_status_check') THEN
    ALTER TABLE payee_proposals
      ADD CONSTRAINT payee_proposals_status_check CHECK (status IN ('draft', 'approved', 'rejected'));
  END IF;
END $$;
