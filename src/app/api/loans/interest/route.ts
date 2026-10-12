/**
 * /api/loans/interest — a loan's interest entries on its linked account.
 *
 *   GET  ?loanId=N[&categoryId=C]
 *        → { accountId, interestCategoryId, categoryId, entries: [{ transactionId, date, amount }] }
 *   PUT  { loanId, categoryId }            → { interestCategoryId }
 *   POST { loanId, categoryId, entries: [{ periodDate, amount, date? }] }
 *        → { created: [{ periodDate, transactionId, amount, date }] }
 *
 * A loan payment stays a plain transfer into the loan account; the interest is
 * a separate expense transaction on that same account. GET reads the ledger —
 * every transaction on the account in the interest category, however it was
 * entered — and the client credits each one to its schedule period with the
 * shared pure `matchInterestToSchedule`. PUT remembers the category. POST
 * generates entries; all its rules live in `postLoanInterest`, shared with MCP
 * `manage_loans(op:"post_interest")`.
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { OwnershipError } from "@/lib/verify-ownership";
import { DEK_LOCKED_MESSAGE } from "@/lib/save-error";
import {
  postLoanInterest,
  readLoanInterest,
  setLoanInterestCategory,
} from "@/lib/loans/interest-entries";
import { ymdDate } from "../../../../../mcp-server/lib/date-validators";

export const dynamic = "force-dynamic";

// A category id the caller does not own reads as "not found", never 403.
const mapError = (err: unknown) =>
  err instanceof OwnershipError ? apiError("Category not found.", 404) : null;

const positiveInt = (raw: string | null): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId }) => {
  const params = new URL(request.url).searchParams;
  const loanId = positiveInt(params.get("loanId"));
  if (loanId == null) return apiError("loanId is required.", 400);
  const state = await readLoanInterest(userId, loanId, positiveInt(params.get("categoryId")));
  if (!state) return apiError("Loan not found.", 404);
  return state;
});

const putSchema = z.object({
  loanId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
});

export const PUT = apiHandler(
  { auth: "auth", body: putSchema, mapError },
  async ({ userId, body }) => {
    await setLoanInterestCategory(userId, body.loanId, body.categoryId);
    return { interestCategoryId: body.categoryId };
  },
);

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
  { auth: "encryption", body: postSchema, mapError },
  async ({ userId, dek, body }) => {
    // `auth: "encryption"` already 423s without a key; this narrows the type.
    if (!dek) return apiError(DEK_LOCKED_MESSAGE, 423);
    const created = await postLoanInterest(userId, dek, { ...body, source: "manual" });
    return { created };
  },
);
