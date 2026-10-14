/** Old payee profile link → /merchants/[id] (P8 stage 1). */
import { redirect } from "next/navigation";

export default async function PayeeProfileRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/merchants/${encodeURIComponent(id)}`);
}
