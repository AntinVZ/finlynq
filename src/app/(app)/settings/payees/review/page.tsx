/** Old AI review link → /merchants/review (P8 stage 1). */
import { redirect } from "next/navigation";

export default function PayeeReviewRedirect() {
  redirect("/merchants/review");
}
