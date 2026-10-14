/**
 * POST /api/rules/test — dry-run a rule's conditions on the user's
 * transactions (P8 stage 10; the web side of MCP `test_rule`).
 * Body `{ conditions: {all: […]}, limit? }` → matched / uncategorized counts
 * and up to 20 sample rows. Read only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { ConditionGroup } from "@/lib/rules/schema";
import { RULE_TEST_MAX, testRuleConditions } from "@/lib/rules/test-rule";

const body = z.object({ conditions: ConditionGroup, limit: z.number().int().positive().max(RULE_TEST_MAX).optional() });

export const POST = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to test the rule" }, async ({ request, userId, dek }) => {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid rule conditions" }, { status: 400 });
  const r = await testRuleConditions({ executor: db, userId, dek, conditions: parsed.data.conditions, limit: parsed.data.limit ?? 20_000, sample: 20 });
  return NextResponse.json(r);
});
