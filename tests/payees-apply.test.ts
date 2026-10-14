/**
 * Payee Studio P6 (B23) — `planPayeeApply` against a fake executor that
 * pages like Postgres does.
 *
 * The bug: the apply scan selected `id::text AS id … ORDER BY id`. Postgres
 * resolves `ORDER BY id` to the OUTPUT column (the text alias), so pages came
 * back in text order ("1", "10", "100", "1000", …, "2", …) while the keyset
 * `id > n` compared numbers — every page after the first skipped rows. On a
 * real ledger the McDonald's rows all sat in skipped ranges: preview 0 rows.
 * The fake executor below renders the real SQL and applies that same rule.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { encryptField } from "@/lib/crypto/envelope";
import { explainEmptyApply, planPayeeApply } from "@/lib/payees/apply";
import { buildPayeeMatcher, type AliasMode, type PayeeEntity } from "@/lib/payees/directory";

const dialect = new PgDialect();

type Row = { id: number; payee: string | null };

/**
 * A `transactions` table in memory. Understands the apply page query:
 * `WHERE user_id = $1 [AND id > $2] ORDER BY id LIMIT $n`, with Postgres'
 * rule that `ORDER BY <name>` means the select-list alias when there is one.
 */
function fakeLedger(rows: Row[]) {
  const queries: string[] = [];
  return {
    queries,
    execute: async (q: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(q);
      queries.push(text);
      if (!/FROM transactions/i.test(text)) return { rows: [] };
      const limit = Number(params[params.length - 1]);
      const after = /id > \$2/.test(text) ? Number(params[1]) : null;
      const textId = /id::text AS id/i.test(text);
      const orderByAlias = textId && /ORDER BY id\s+LIMIT/i.test(text);
      const page = rows
        .filter((r) => after == null || r.id > after)
        .sort((a, b) => (orderByAlias ? String(a.id).localeCompare(String(b.id)) : a.id - b.id))
        .slice(0, limit)
        .map((r) => ({ id: textId ? String(r.id) : r.id, payee: r.payee, tier: null }));
      return { rows: page };
    },
  };
}

function entity(id: number, name: string, aliases: Array<{ pattern: string; mode?: AliasMode }> = []): PayeeEntity {
  return {
    id,
    name,
    type: "retail",
    note: null,
    defaultCategoryId: null,
    website: null,
    logo: null,
    merchantTypeId: null,
    createdAt: null,
    updatedAt: null,
    aliases: [
      { id: id * 100, entityId: id, pattern: name, mode: "exact", source: "canonical", createdAt: null },
      ...aliases.map((a, i) => ({ id: id * 100 + i + 1, entityId: id, pattern: a.pattern, mode: a.mode ?? ("exact" as AliasMode), source: "manual", createdAt: null })),
    ],
    identifiers: [],
  };
}

/** ids 1..5000; McDonald's spellings sit in ranges a text-ordered keyset skips (300–999). */
function ledger(payeeAt: (id: number) => string | null): Row[] {
  return Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, payee: payeeAt(i + 1) }));
}
const mcd = (id: number) => (id >= 300 && id < 356 ? "McDonalds 127" : id >= 500 && id < 511 ? "MCDONALDS 109" : `Filler ${id % 7}`);

describe("planPayeeApply (B23)", () => {
  it("the fake executor reproduces the text-order keyset skip", async () => {
    const db = fakeLedger(ledger(() => "x"));
    // The pre-fix query shape: text alias + ORDER BY id.
    let after: number | null = null;
    let seen = 0;
    for (;;) {
      const q: SQL = sql`SELECT id::text AS id, payee FROM transactions WHERE user_id = ${"u"} ${after != null ? sql`AND id > ${after}` : sql``} ORDER BY id LIMIT ${2000}`;
      const page: Array<{ id: string }> = ((await db.execute(q)) as { rows: Array<{ id: string }> }).rows;
      seen += page.length;
      if (page.length) after = Number(page[page.length - 1].id);
      if (page.length < 2000) break;
    }
    expect(seen).toBe(4201); // 799 rows never seen — same as on a real Postgres
  });

  it("finds every McDonald's row through the canonical exact alias (key ignores the store number)", async () => {
    const db = fakeLedger(ledger(mcd));
    const matcher = buildPayeeMatcher([entity(17, "McDonald's")]);
    const plan = await planPayeeApply({ executor: db, userId: "u", dek: null, matcher, entityIds: new Set([17]), tables: ["transactions"] });
    expect(plan.total).toBe(67);
    expect(plan.changes.map((c) => [c.from, c.count])).toEqual([
      ["McDonalds 127", 56],
      ["MCDONALDS 109", 11],
    ]);
    expect(plan.diagnostics.scanned).toBe(5000);
    expect(db.queries.every((q) => !/id::text AS id/i.test(q))).toBe(true);
    // Without an entity filter: the same rows.
    const all = await planPayeeApply({ executor: db, userId: "u", dek: null, matcher, tables: ["transactions"] });
    expect(all.total).toBe(67);
  });

  it("matches a contains alias, also with encrypted payees", async () => {
    const dek = randomBytes(32);
    const db = fakeLedger(ledger((id) => encryptField(dek, mcd(id))));
    const matcher = buildPayeeMatcher([entity(17, "Макдональдз", [{ pattern: "McDonalds", mode: "contains" }])]);
    const plan = await planPayeeApply({ executor: db, userId: "u", dek, matcher, entityIds: new Set([17]), tables: ["transactions"] });
    expect(plan.total).toBe(67);
    expect(plan.rows.every((r) => r.entityId === 17)).toBe(true);
  });

  it("explains an empty preview: look-alike spellings without an alias", async () => {
    const db = fakeLedger(ledger((id) => (id >= 300 && id < 310 ? "McDonalds Drive 12" : "Filler")));
    const matcher = buildPayeeMatcher([entity(17, "McDonald's")]);
    const plan = await planPayeeApply({ executor: db, userId: "u", dek: null, matcher, entityIds: new Set([17]), tables: ["transactions"] });
    expect(plan.total).toBe(0);
    expect(plan.diagnostics.nearMisses).toEqual([{ payee: "McDonalds Drive 12", entityId: 17, count: 10 }]);
    const why = explainEmptyApply(plan, () => "McDonald's");
    expect(why).toContain("No aliases for 1 spelling (10 rows)");
    expect(why).toContain("«McDonalds Drive 12»");
  });

  it("explains an empty preview: rows already canonical, or not decryptable", async () => {
    const canonical = fakeLedger(ledger((id) => (id < 20 ? "McDonald's" : "Filler")));
    const matcher = buildPayeeMatcher([entity(17, "McDonald's")]);
    const p1 = await planPayeeApply({ executor: canonical, userId: "u", dek: null, matcher, tables: ["transactions"] });
    expect(p1.total).toBe(0);
    expect(explainEmptyApply(p1, () => undefined)).toContain("19 rows already have the canonical name");

    const dek = randomBytes(32);
    const locked = fakeLedger(ledger((id) => encryptField(dek, mcd(id))));
    const p2 = await planPayeeApply({ executor: locked, userId: "u", dek: null, matcher, tables: ["transactions"] });
    expect(p2.total).toBe(0);
    expect(p2.diagnostics.undecryptable).toBe(5000);
    expect(explainEmptyApply(p2, () => undefined)).toContain("couldn't be decrypted");
  });
});
