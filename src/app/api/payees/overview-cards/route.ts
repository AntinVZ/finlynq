/**
 * GET /api/payees/overview-cards?period=30d|90d|1y — the Merchants overview
 * cards (P8 stage 2): coverage, top-5 uncovered, new merchants, large
 * checks, duplicates, silent subscriptions, untyped. Read only; cached per
 * user and period for two minutes and dropped on every directory change.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { makeSliceConverter } from "@/lib/payees/service";
import { computeOverviewCards, OVERVIEW_PERIODS, type OverviewCards, type OverviewPeriod } from "@/lib/payees/overview-cards";
import { matcherFor } from "@/lib/payees/resolve-hint";
import { loadOwnMatcher } from "@/lib/payees/own-accounts";
import { getPayeeSettings, vocabularyOf } from "@/lib/payees/settings";
import { overviewCache } from "@/lib/payees/queue-cache";

const TTL_MS = 120_000;

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load the overview" }, async ({ request, userId, dek }) => {
  const raw = request.nextUrl.searchParams.get("period") ?? "90d";
  const period: OverviewPeriod = (OVERVIEW_PERIODS as readonly string[]).includes(raw) ? (raw as OverviewPeriod) : "90d";
  const key = `${userId}:${period}`;
  const hit = overviewCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.counts);
  const [matcher, own, settings, converter] = await Promise.all([
    matcherFor({ executor: db, userId, dek: dek! }),
    loadOwnMatcher(db, userId, dek),
    getPayeeSettings(db, userId),
    makeSliceConverter(userId),
  ]);
  const cards: OverviewCards = await computeOverviewCards({
    executor: db,
    userId,
    dek,
    matcher,
    own,
    vocab: vocabularyOf(settings),
    convert: converter.convert,
    currency: converter.currency,
    period,
  });
  overviewCache.set(key, { at: Date.now(), counts: cards });
  return NextResponse.json(cards);
});
