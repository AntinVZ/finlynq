"use client";

import { useEffect, useState } from "react";

/** The little an account screen needs to point at a loan. */
export type LinkedLoan = { id: number; name: string };

type LoanRow = { id: number; name?: string | null; accountId?: number | null };

/**
 * Loans grouped by the account they are linked to. Pure, so the rule is
 * testable: a loan with no linked account is in no group, and a nameless loan
 * (its name could not be decrypted) still gets a usable label.
 */
export function groupLoansByAccount(loans: readonly LoanRow[]): Map<number, LinkedLoan[]> {
  const map = new Map<number, LinkedLoan[]>();
  for (const l of loans) {
    if (l.accountId == null) continue;
    const list = map.get(l.accountId) ?? [];
    list.push({ id: l.id, name: (l.name ?? "").trim() || "Loan" });
    map.set(l.accountId, list);
  }
  return map;
}

/** Where a loan opens: its schedule panel on the Loans page. */
export function loanHref(loanId: number): string {
  return `/loans?loan=${loanId}`;
}

/**
 * The user's loans keyed by linked account id, so an account can link to the
 * loan that tracks it. One fetch per mount. A failure leaves the map empty:
 * the link is a convenience and must never break the account screen.
 */
export function useLinkedLoans(): Map<number, LinkedLoan[]> {
  const [byAccount, setByAccount] = useState<Map<number, LinkedLoan[]>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    fetch("/api/loans")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setByAccount(groupLoansByAccount(Array.isArray(data) ? data : []));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return byAccount;
}
