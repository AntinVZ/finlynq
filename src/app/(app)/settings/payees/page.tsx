/**
 * Settings → Payees moved to the top-level Merchants section (P8 stage 1);
 * old links and bookmarks land there.
 */
import { redirect } from "next/navigation";

export default function PayeesSettingsRedirect() {
  redirect("/merchants");
}
