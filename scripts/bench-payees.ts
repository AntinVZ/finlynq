/**
 * Payee Studio benchmark (P5e / B20b) — synthetic ledger, timings, peak memory.
 *
 *   DATABASE_URL=postgres://…/finlynq_test npx tsx scripts/bench-payees.ts [txCount] [payeeCount]
 *
 * Seeds ONE throwaway user into a `*_test` database (refuses anything else):
 * `txCount` transactions (default 60,000) over `payeeCount` distinct payees
 * (default 8,000) — encrypted with a fixed test DEK like production, spread
 * over 3 years, with Latin / Cyrillic / terminal-noise variants and ~5 %
 * people — plus a directory of 400 entries. Then times every Payee Studio
 * read path: scan, overview (groups + clusters), look-alikes, insights,
 * merchant analyses, suggestions. Reports wall time and peak RSS / heap.
 * Deletes the user's rows at the end.
 */
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "bench-jwt-secret-for-payees-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "bench-pepper-32chars-for-payees-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "bench-staging-key-32chars-payees-ok!";

const TX = Number(process.argv[2] ?? 60_000);
const PAYEES = Number(process.argv[3] ?? 8_000);
const DEK = Buffer.alloc(32, 0xaa);

const STEMS = ["Епіцентр", "Сільпо", "АТБ Маркет", "Нова Пошта", "Rozetka", "Comfy", "Фокстрот", "Glovo", "Uklon", "Bolt", "Netflix", "Spotify", "Google", "Apple", "Kyivstar", "Varus", "Novus", "Metro", "Auchan", "McDonald's", "KFC", "Аптека Доброго Дня", "Піцерія Челентано", "Coffee Lab", "Пекарня Хлібна Хата"];
const PEOPLE = ["Степаненко", "Деркач Олександр Петрович", "Іваненко Марія Іванівна", "ФОП Давидзон О. М.", "Коваль Петро"];
const CITIES = ["KYIV", "LVIV", "ODESA", "DNIPRO", ""];

function payeeName(i: number): string {
  if (i % 20 === 0) return `${PEOPLE[i % PEOPLE.length]} ${i}`;
  const stem = STEMS[i % STEMS.length];
  const variant = Math.floor(i / STEMS.length);
  const kind = variant % 4;
  if (kind === 0) return `${stem} ${variant}`;
  if (kind === 1) return `${stem.toUpperCase()} K${variant % 90} ${CITIES[variant % CITIES.length]} ${100000 + variant}`.trim();
  if (kind === 2) return `${stem} Store ${variant}`;
  return `POS ${stem} #${variant}`;
}

function mem() {
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/\/[^/]*_test([?#]|$)/.test(url)) throw new Error("DATABASE_URL must name a *_test database.");
  const { PostgresAdapter, setAdapter, setDialect, db } = await import("@/db");
  const adapter = new PostgresAdapter();
  await adapter.initialize({ dialect: "postgres", postgres: { connectionString: url, userId: "" } });
  setAdapter(adapter);
  setDialect("postgres");
  const { encryptField } = await import("@/lib/crypto/envelope");
  const { buildNameFields } = await import("@/lib/crypto/encrypted-columns");

  let peak = mem();
  const sampler = setInterval(() => {
    const m = mem();
    if (m.rss > peak.rss) peak = { ...peak, rss: m.rss };
    if (m.heap > peak.heap) peak = { ...peak, heap: m.heap };
  }, 20);

  const userId = randomUUID();
  const now = new Date().toISOString();
  await db.execute(sql`INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at) VALUES (${userId}, ${"bench-" + userId.slice(0, 8)}, ${userId.slice(0, 8) + "@bench.local"}, 'x', 'user', ${now}, ${now})`);
  await db.execute(sql`INSERT INTO settings (key, user_id, value) VALUES ('display_currency', ${userId}, 'UAH')`);
  const acct = buildNameFields(DEK, { name: "Bench UAH" });
  const ar = (await db.execute(sql`INSERT INTO accounts (user_id, type, "group", currency, name_ct, name_lookup) VALUES (${userId}, 'A', '', 'UAH', ${acct.nameCt}, ${acct.nameLookup}) RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
  const accountId = Number(ar.rows[0].id);

  const names = Array.from({ length: PAYEES }, (_, i) => payeeName(i));
  const t0 = Date.now();
  for (let i = 0; i < TX; i += 1000) {
    const rows = [];
    for (let k = i; k < Math.min(TX, i + 1000); k++) {
      // Zipf-ish: popular payees get many rows.
      const p = names[Math.floor(PAYEES * Math.pow((k * 7919) % TX / TX, 2.2)) % PAYEES];
      const day = new Date(Date.UTC(2023, 9, 1) + ((k * 37) % (3 * 365)) * 86_400_000).toISOString().slice(0, 10);
      const amount = -Math.round(((k * 97) % 5000) + 20);
      rows.push(sql`(${userId}, ${day}, ${accountId}, 'UAH', ${amount}, ${amount}, 'UAH', ${encryptField(DEK, p)}, '', '', 'import', ${"b-" + k + "-" + userId.slice(0, 6)})`);
    }
    await db.execute(sql`INSERT INTO transactions (user_id, date, account_id, currency, amount, reporting_amount, reporting_currency, payee, note, tags, source, import_hash) VALUES ${sql.join(rows, sql`, `)}`);
  }
  const seedMs = Date.now() - t0;

  // A directory of 400 entries (canonical name + one exact alias each).
  const { insertEntity, insertAlias } = await import("@/lib/payees/directory");
  for (let i = 0; i < 400; i++) {
    const name = names[i * 7];
    const id = await insertEntity(db, userId, DEK, { name, type: i % 20 === 0 ? "person" : "retail" });
    await insertAlias(db, userId, DEK, { entityId: id, pattern: name, mode: "exact", source: "canonical" });
    await insertAlias(db, userId, DEK, { entityId: id, pattern: names[i * 7 + 1], mode: "exact", source: "manual" });
  }

  const results: Array<{ step: string; ms: number; detail?: string }> = [];
  const time = async <T,>(step: string, fn: () => Promise<T>, detail?: (r: T) => string) => {
    const s = Date.now();
    const r = await fn();
    results.push({ step, ms: Date.now() - s, detail: detail?.(r) });
    return r;
  };

  const { scanPayees } = await import("@/lib/payees/scan");
  const { loadPayeeOverview, loadLookalikes, loadMerchantAnalytics, makeSliceConverter, suggestPayees } = await import("@/lib/payees/service");
  const { computePayeeInsights } = await import("@/lib/payees/insights");
  const { buildPayeeMatcher, loadDirectory } = await import("@/lib/payees/directory");

  await time("scan (all 5 tables)", () => scanPayees({ executor: db, userId, dek: DEK }), (r) => `${r.spellings.size} spellings, ${r.scanned.transactions} tx rows`);
  const overview = await time("overview (scan + groups + clusters + directory)", () => loadPayeeOverview({ executor: db, userId, dek: DEK, currency: "UAH" }), (o) => `${o.groups.length} groups, ${o.clusters.length} clusters`);
  await time("look-alikes (on the overview)", () => loadLookalikes({ executor: db, userId, dek: DEK, overview }), (r) => `${r.candidates.length} candidates, ${r.unrenamed.length} unrenamed`);
  await time("overview + look-alikes (GET /api/payees)", async () => {
    const o = await loadPayeeOverview({ executor: db, userId, dek: DEK, currency: "UAH" });
    return loadLookalikes({ executor: db, userId, dek: DEK, overview: o });
  });
  const { convert, currency } = await makeSliceConverter(userId, "UAH");
  await time("insights (P4)", async () => computePayeeInsights({ executor: db, userId, dek: DEK, matcher: buildPayeeMatcher(await loadDirectory(db, userId, DEK)), convert, currency }), (r) => `${r.totals.counterparties} counterparties`);
  await time("merchant analyses (P5d)", () => loadMerchantAnalytics({ executor: db, userId, dek: DEK, currency: "UAH" }), (r) => `${r.counterparties} counterparties, truncated=${r.truncated}`);
  await time("suggest (cold: builds the index)", () => suggestPayees({ executor: db, userId, dek: DEK, q: "епі" }), (r) => `${r.length} hits`);
  await time("suggest (warm)", () => suggestPayees({ executor: db, userId, dek: DEK, q: "rozet" }), (r) => `${r.length} hits`);

  clearInterval(sampler);
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  console.log(`\nPayee Studio benchmark — ${TX.toLocaleString("en-US")} transactions, ${PAYEES.toLocaleString("en-US")} payees, 400 directory entries`);
  console.log(`seed: ${(seedMs / 1000).toFixed(1)} s (not part of the measurement)`);
  for (const r of results) console.log(`  ${r.step.padEnd(48)} ${(r.ms / 1000).toFixed(2).padStart(6)} s  ${r.detail ?? ""}`);
  console.log(`peak RSS ${mb(peak.rss)}, peak heap ${mb(peak.heap)} (Node ${process.version})`);

  for (const t of ["transactions", "payee_aliases", "payee_identifiers", "payee_batches", "payee_entities", "accounts", "settings"]) {
    await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE user_id = ${userId}`);
  }
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
