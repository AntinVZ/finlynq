/**
 * The account page's New transaction dialog must know about every account.
 *
 * It was handed the viewed account alone (2026-10-13, owner report). The
 * Transaction tab looked fine, but the Transfer tab removes the source account
 * from the destination list, so that list was empty and read "No matches": a
 * transfer could not be made from an account's own page at all.
 *
 * A wiring fault, so a static gate: the dialog's own filters were correct and
 * their tests passed throughout.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Strip comments so a rule quoted in prose can't satisfy a code assertion. */
const code = readFileSync(join(process.cwd(), "src/app/(app)/accounts/[id]/page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const dialog = code.slice(code.indexOf("<TransactionDialog"));

describe("account page: New transaction dialog", () => {
  it("is given the whole account list, never a one-account array", () => {
    expect(dialog).toMatch(/accounts=\{dialogAccounts\}/);
    expect(code).toMatch(/const dialogAccounts: DialogAccount\[\] = accounts\.map\(/);
    expect(dialog).not.toMatch(/accounts=\{\[/);
  });

  it("pre-selects the viewed account on both tabs", () => {
    expect(dialog).toMatch(/values: \{ accountId: String\(account\.id\)/);
    expect(dialog).toMatch(/transferSeed: \{ fromAccountId: String\(account\.id\) \}/);
  });

  // The dialog hides archived accounts when creating; the page being viewed
  // must stay selectable in its own dialog.
  it("keeps the viewed account selectable when it is archived", () => {
    expect(code).toMatch(/a\.id === account\.id \? \{ \.\.\.a, archived: false \} : a/);
  });
});
