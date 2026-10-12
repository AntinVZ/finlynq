/**
 * User-DEK-encrypted column registry (2026-06-01).
 *
 * Single source of truth for "which free-text columns are user-DEK encrypted
 * envelopes". Drives:
 *   - the login sweep (`upgradeUserFieldEncryption`, Phase 5) which re-encrypts
 *     any remaining plaintext (legacy / stdio / email-import rows), and
 *   - the audit invariant (Phase 6) that guards against new plaintext writers.
 *
 * Scope is the `note`/`notes`/`payee` free-text columns plus the transaction +
 * split columns that were already encrypted before this plan. Transaction
 * RULES are NOT in this list — their sensitive fields live inside JSONB and are
 * handled by `src/lib/rules/crypto.ts` + a dedicated sweep branch.
 *
 * Stream D display-`name` columns are intentionally NOT here: post-Phase-4
 * there is no plaintext name column left to sweep (they were physically
 * dropped), and they carry a `name_lookup` HMAC sibling that the generic
 * envelope sweep would not maintain.
 *
 * Most registered tables have a direct `user_id` column and the sweep filters
 * `WHERE user_id = $1`. A table WITHOUT a `user_id` of its own (only
 * `transaction_splits` today — owned via `transaction_id → transactions`) MUST
 * declare a `userScope` override (see {@link UserScopeViaParent}) or the sweep
 * raises SQLSTATE 42703 and silently skips the whole table. The
 * `tests/upgrade-user-fields.test.ts` registry/schema consistency test guards
 * this.
 *
 * See plan/encryption-plaintext-gaps.md.
 */

export type UserEncryptedKind = "envelope";

/**
 * How the login sweep scopes a table's rows to one user when the table has NO
 * `user_id` column of its own and is owned transitively through a parent FK.
 *
 * `transaction_splits` is the only such table today: a split is owned via
 * `transaction_id → transactions.user_id`. The sweep filters
 * `WHERE <fkColumn> IN (SELECT id FROM <parentTable> WHERE user_id = $1)`
 * instead of a direct `WHERE user_id = $1` (which 42703s — the column doesn't
 * exist).
 */
export interface UserScopeViaParent {
  /** FK column on THIS table pointing at the parent's `id`. */
  fkColumn: string;
  /** Parent table that carries the `user_id` (and an `id` PK). */
  parentTable: string;
}

export interface UserEncryptedColumn {
  /** PostgreSQL table name (snake_case, matches the physical schema). */
  table: string;
  /** PostgreSQL column name (snake_case). */
  column: string;
  kind: UserEncryptedKind;
  /**
   * User-ownership scoping for the login sweep.
   *
   * DEFAULT (omitted): the table has a direct `user_id` column; the sweep
   * filters `WHERE user_id = $1`.
   *
   * When set: the table has no `user_id` of its own and is scoped transitively
   * through a parent FK (see {@link UserScopeViaParent}). REQUIRED for any
   * table without a `user_id` column, or the sweep raises SQLSTATE 42703.
   */
  userScope?: UserScopeViaParent;
}

/**
 * Every user-owned free-text column that is a v1: envelope at rest.
 *
 * Table/column names are the PHYSICAL (snake_case) names so the sweep can build
 * raw SQL and the audit invariant can grep source for the matching Drizzle
 * camelCase writers. The registry is keyed by physical names because the sweep
 * issues `SELECT id, <col> FROM <table> WHERE <col> NOT LIKE 'v1:%'` directly.
 */
export const USER_ENCRYPTED_COLUMNS: ReadonlyArray<UserEncryptedColumn> = [
  // Pre-existing scope (encrypted before this plan; included so the sweep
  // also mops up the 72/144 legacy + stdio-written plaintext payees/notes).
  { table: "transactions", column: "payee", kind: "envelope" },
  { table: "transactions", column: "note", kind: "envelope" },
  { table: "transactions", column: "tags", kind: "envelope" },
  // transaction_splits has NO user_id column — splits are owned through their
  // parent transaction (transaction_id → transactions.user_id). The sweep MUST
  // scope via the parent or it 42703s ("column user_id does not exist").
  { table: "transaction_splits", column: "note", kind: "envelope", userScope: { fkColumn: "transaction_id", parentTable: "transactions" } },
  { table: "transaction_splits", column: "description", kind: "envelope", userScope: { fkColumn: "transaction_id", parentTable: "transactions" } },
  { table: "transaction_splits", column: "tags", kind: "envelope", userScope: { fkColumn: "transaction_id", parentTable: "transactions" } },
  // New scope (this plan) — free-text note columns.
  { table: "loans", column: "note", kind: "envelope" },
  { table: "goals", column: "note", kind: "envelope" },
  { table: "snapshots", column: "note", kind: "envelope" },
  { table: "subscriptions", column: "notes", kind: "envelope" },
  { table: "fx_overrides", column: "note", kind: "envelope" },
  { table: "contribution_room", column: "note", kind: "envelope" },
  { table: "recurring_transactions", column: "payee", kind: "envelope" },
  { table: "recurring_transactions", column: "note", kind: "envelope" },
  // MCP-write-only free-text notes (no REST writer, never displayed today, but
  // the MCP add_*/update_* tools encrypt them at the source — keep them swept so
  // legacy plaintext MCP-written notes don't survive a DB leak. Plan Phase 2
  // explicitly lists add_account / update_account / create_category as note
  // writers; the legacy `net_worth_snapshots.note` (add_snapshot) is encrypted
  // at write but deliberately NOT swept — it is a pre-Drizzle raw table that is
  // never read back and may not exist on every deployment.)
  { table: "accounts", column: "note", kind: "envelope" },
  { table: "categories", column: "note", kind: "envelope" },
  // Payee Studio directory (P2): every write encrypts; swept as a backstop.
  { table: "payee_entities", column: "name", kind: "envelope" },
  { table: "payee_entities", column: "note", kind: "envelope" },
  { table: "payee_entities", column: "website", kind: "envelope" },
  { table: "payee_entities", column: "logo", kind: "envelope" },
  { table: "payee_aliases", column: "pattern", kind: "envelope" },
  { table: "payee_identifiers", column: "value", kind: "envelope" },
  { table: "payee_batches", column: "undo_data", kind: "envelope" },
  { table: "payee_proposals", column: "payload", kind: "envelope" },
];
