"use client";

/**
 * /settings/usage-mode — personal only, or personal + business.
 * Business mode adds the All / Business / Personal switcher at the top of the
 * app (see lib/view-scope.ts).
 */

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Briefcase, User } from "lucide-react";
import { useViewScope } from "@/components/view-scope-provider";
import type { UsageMode } from "@/lib/view-scope";
import { cn } from "@/lib/utils";

const OPTIONS: { value: UsageMode; title: string; text: string; icon: typeof User }[] = [
  {
    value: "personal",
    title: "Personal only",
    text: "Everything is your own money. No business switches anywhere.",
    icon: User,
  },
  {
    value: "business_too",
    title: "Personal and business",
    text: "You also track business spending. A switch at the top of the app lets you view All, Business or Personal.",
    icon: Briefcase,
  },
];

export default function UsageModeSettingsPage() {
  const { usageMode, isLoading, setUsageMode } = useViewScope();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  async function choose(mode: UsageMode) {
    if (mode === usageMode) return;
    setSaving(true);
    setStatus("");
    try {
      await setUsageMode(mode);
      setStatus("Saved");
    } catch {
      setStatus("Couldn't save. Try again.");
    }
    setSaving(false);
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage mode</h1>
        <p className="text-sm text-muted-foreground mt-0.5">How you use Finlynq</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Do you track business money too?</CardTitle>
          <CardDescription>You can change this any time. Nothing is deleted.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div role="radiogroup" aria-label="Usage mode" className="grid gap-3 sm:grid-cols-2">
            {OPTIONS.map((opt) => {
              const selected = usageMode === opt.value;
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={isLoading || saving}
                  onClick={() => choose(opt.value)}
                  className={cn(
                    "rounded-xl border p-4 text-left transition-colors disabled:opacity-60",
                    selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className={cn("h-4 w-4", selected ? "text-primary" : "text-muted-foreground")} />
                    <span className="text-sm font-medium">{opt.title}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">{opt.text}</p>
                </button>
              );
            })}
          </div>
          {status && <p className="text-xs text-muted-foreground">{status}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How business tracking works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>You mark single transactions as business. Accounts are not business or personal.</p>
          <p>
            The switch changes income, spending and category figures. Balances and net worth always
            count every account, because one account can hold both kinds of money.
          </p>
          <p>The AI assistant (MCP) ignores the switch. Ask it for business or personal figures directly.</p>
        </CardContent>
      </Card>
    </div>
  );
}
