import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { getViewScope, setViewScope } from "@/lib/settings/view-scope-settings";
import { VIEW_SCOPES, parseViewScope } from "@/lib/view-scope";

// Returns the STORED scope. Whether it applies depends on usage_mode (in
// personal mode the effective scope is always "all"); the client resolves
// that through effectiveScope() in lib/view-scope.ts.
export const GET = apiHandler({ auth: "auth", raw: true, fallbackMessage: "Failed to load the setting" }, async ({ userId }) => {
  const viewScope = await getViewScope(userId);
  return NextResponse.json({ viewScope });
});

export const PUT = apiHandler({ auth: "auth", raw: true, fallbackMessage: "Failed to save the setting" }, async ({ request, userId }) => {
  const body = await request.json().catch(() => null);
  const viewScope = parseViewScope(body?.viewScope);
  if (!viewScope) {
    return NextResponse.json(
      { error: `viewScope must be one of: ${VIEW_SCOPES.join(", ")}` },
      { status: 400 },
    );
  }

  await setViewScope(userId, viewScope);
  return NextResponse.json({ viewScope });
});
