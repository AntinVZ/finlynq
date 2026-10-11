import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getViewScope, setViewScope } from "@/lib/settings/view-scope-settings";
import { VIEW_SCOPES, parseViewScope } from "@/lib/view-scope";

// Returns the STORED scope. Whether it applies depends on usage_mode (in
// personal mode the effective scope is always "all"); the client resolves
// that through effectiveScope() in lib/view-scope.ts.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const viewScope = await getViewScope(auth.context.userId);
  return NextResponse.json({ viewScope });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const body = await request.json().catch(() => null);
  const viewScope = parseViewScope(body?.viewScope);
  if (!viewScope) {
    return NextResponse.json(
      { error: `viewScope must be one of: ${VIEW_SCOPES.join(", ")}` },
      { status: 400 },
    );
  }

  await setViewScope(auth.context.userId, viewScope);
  return NextResponse.json({ viewScope });
}
