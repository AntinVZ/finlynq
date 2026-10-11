import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { getUsageMode, setUsageMode } from "@/lib/settings/view-scope-settings";
import { USAGE_MODES, parseUsageMode } from "@/lib/view-scope";

export const GET = apiHandler({ auth: "auth", raw: true, fallbackMessage: "Failed to load the setting" }, async ({ userId }) => {
  const usageMode = await getUsageMode(userId);
  return NextResponse.json({ usageMode });
});

export const PUT = apiHandler({ auth: "auth", raw: true, fallbackMessage: "Failed to save the setting" }, async ({ request, userId }) => {
  const body = await request.json().catch(() => null);
  const usageMode = parseUsageMode(body?.usageMode);
  if (!usageMode) {
    return NextResponse.json(
      { error: `usageMode must be one of: ${USAGE_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  await setUsageMode(userId, usageMode);
  return NextResponse.json({ usageMode });
});
