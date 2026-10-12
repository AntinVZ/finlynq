/**
 * Payee Studio fixtures: the real-world spellings the feature is built for.
 * `count` is how many transactions carry each spelling.
 */
export const PAYEE_FIXTURES: Array<{ payee: string; count: number; amount: number }> = [
  { payee: "Епіцентр", count: 20, amount: -450 },
  { payee: "Epicentr", count: 5, amount: -300 },
  { payee: "EPITCENTR K10 KYIV 360616", count: 3, amount: -120 },
  { payee: "Епіцентр К", count: 2, amount: -999 },
  { payee: "Деркач Олександр Петрович", count: 4, amount: -1500 },
  { payee: "DERKACH OLEKSANDR PETROVYCH", count: 1, amount: -1500 },
  { payee: "FOP DAVYDZON O. M.", count: 3, amount: -800 },
  { payee: "Colin's", count: 2, amount: -1200 },
  { payee: "Colin’s", count: 1, amount: -1100 },
  { payee: "Атб Маркет", count: 6, amount: -230 },
  { payee: "ATB MARKET", count: 4, amount: -180 },
  { payee: "BULOCHKA SHOP", count: 2, amount: -95 },
  { payee: "BINANCE.COM*A1B2C3D4E5 1234567890123 LONDON GB", count: 1, amount: -5000 },
];

/** Expand fixtures to one entry per transaction, with dates spread over months. */
export function expandPayeeFixtures(): Array<{ payee: string; amount: number; date: string }> {
  const out: Array<{ payee: string; amount: number; date: string }> = [];
  let n = 0;
  for (const f of PAYEE_FIXTURES) {
    for (let i = 0; i < f.count; i++) {
      const month = String((n % 12) + 1).padStart(2, "0");
      const day = String((i % 27) + 1).padStart(2, "0");
      out.push({ payee: f.payee, amount: f.amount, date: `2026-${month}-${day}` });
      n++;
    }
  }
  return out;
}

/** A 1×1 PNG (base64), for logo tests. */
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
