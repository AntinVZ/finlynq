/**
 * /api/loans/interest — book a loan's interest into its linked account.
 *
 *   GET  ?loanId=N → { postings: [{ periodDate, transactionId, amount, date }] }
 *   POST { loanId, categoryId, entries: [{ periodDate, amount, date? }] }
 *        → { created: [...] }
 *
 * A loan payment stays a plain transfer into the loan account; the interest is
 * a separate expense entry on that same account. `entries[].amount` is whatever
 * the user wants booked for that period — the schedule's figure by default, or
 * their own number when the lender's differs. All the rules live in
 * `postLoanInterest`, shared with MCP `manage_loans(op:"post_interest")`.
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { OwnershipError } from "@/lib/verify-ownership";
import { DEK_LOCKED_MESSAGE } from "@/lib/save-error";
import { listInterestPostings, postLoanInterest } from "@/lib/loans/interest-postings";
import { ymdDate } from "../../../../../mcp-server/lib/date-validators";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId }) => {
  const loanId = Number(new URL(request.url).searchParams.get("loanId"));
  if (!Number.isInteger(loanId) || loanId <= 0) return apiError("loanId is required.", 400);
  return { postings: await listInterestPostings(userId, loanId) };
});

const postSchema = z.object({
  loanId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  entries: z
    .array(
      z.object({
        periodDate: ymdDate,
        amount: z.number().positive(),
        date: ymdDate.optional(),
      }),
    )
    .min(1)
    .max(600),
});

export const POST = apiHandler(
  {
    auth: "encryption",
    body: postSchema,
    // A category id the caller does not own reads as "not found", never 403.
    mapError: (err) => (err instanceof OwnershipError ? apiError("Category not found.", 404) : null),
  },
  async ({ userId, dek, body }) => {
    // `auth: "encryption"` already 423s without a key; this narrows the type.
    if (!dek) return apiError(DEK_LOCKED_MESSAGE, 423);
    const created = await postLoanInterest(userId, dek, { ...body, source: "manual" });
    return { created };
  },
);
