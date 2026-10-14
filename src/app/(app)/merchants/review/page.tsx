"use client";

/**
 * /merchants/review — AI review. The drafts list lives in
 * `AiDraftsPanel` (P8 stage 9), shared with the Merchants queue tab
 * «Чернетки AI»; see that file for what accepting does.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AiDraftsPanel } from "../_components/ai-drafts-panel";
import { useStudioT } from "../_components/i18n";

export default function PayeeReviewPage() {
  const t = useStudioT();
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <Link href="/merchants" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" /> {t("page.title")}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight mt-1">{t("review.title")}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t("review.subtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("review.proposals")}</CardTitle>
          <CardDescription>{t("review.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AiDraftsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
