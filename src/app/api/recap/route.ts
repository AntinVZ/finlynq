import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyRecap } from "@/lib/weekly-recap";
import { requireAuth } from "@/lib/auth/require-auth";
import { BUSINESS_PARAM, parseBusinessParam } from "@/lib/reports/business-filter";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;
  // Recap tolerates a missing DEK â€” payees will render as ciphertext on
  // encrypted rows, but the rest of the recap (totals, categories, budgets)
  // stays correct. Better than 423ing the whole dashboard.
  const dateParam = request.nextUrl.searchParams.get("date") ?? undefined;
  // Optional business=true|false|all (default all): scopes the recap's flow
  // figures; net-worth change and upcoming bills always cover everything.
  const business = parseBusinessParam(request.nextUrl.searchParams.get(BUSINESS_PARAM));
  const recap = await generateWeeklyRecap(userId, dateParam, dek, business);
  return NextResponse.json({ ...recap, business });
}
