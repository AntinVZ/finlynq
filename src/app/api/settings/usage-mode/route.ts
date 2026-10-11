import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getUsageMode, setUsageMode } from "@/lib/settings/view-scope-settings";
import { USAGE_MODES, parseUsageMode } from "@/lib/view-scope";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const usageMode = await getUsageMode(auth.context.userId);
  return NextResponse.json({ usageMode });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const body = await request.json().catch(() => null);
  const usageMode = parseUsageMode(body?.usageMode);
  if (!usageMode) {
    return NextResponse.json(
      { error: `usageMode must be one of: ${USAGE_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  await setUsageMode(auth.context.userId, usageMode);
  return NextResponse.json({ usageMode });
}
