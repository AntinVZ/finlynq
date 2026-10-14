/**
 * The entity type (retail | service | … | person | sole_proprietor) is no
 * longer picked by hand in the main forms (P6.1): the merchant type is. This
 * derives the stored entity type from the chosen merchant type and the name's
 * type guess, so the rules that depend on it keep working — above all "people
 * are never merged automatically": a person-looking name stays a person
 * whatever merchant type is picked.
 *
 * Pure (web and server).
 */
import { normalizeForMatch } from "@/lib/text-normalize";
import type { PayeeType } from "./match-key";

/** The starting-set group for private persons and sole proprietors. */
export const PERSONS_MERCHANT_GROUP = "Особи і ФОП";
/** P8 stage 11: the starting-set group for colleagues — private persons, kept apart from ФОП. */
export const COLLEAGUES_MERCHANT_GROUP = "Колеги";

const iso = (s: string) => normalizeForMatch(s).replace(/\s+/g, " ").trim();

/** Starting-set groups with an obvious entity type (used when the name gives no signal). */
const GROUP_TYPE: Record<string, PayeeType> = {
  [iso("Банки і комісії")]: "bank",
  [iso("Банківські операції")]: "bank",
  [iso("Держава і податки")]: "government",
  [iso("Онлайн-сервіси та підписки")]: "service",
  [iso("Комунальні й зв'язок")]: "service",
};

/** «Колеги», by its starting-set name or its stable key `colleagues`. */
export function isColleaguesMerchantGroup(group: string | null | undefined, code?: string | null): boolean {
  return code === "colleagues" || (group != null && iso(group) === iso(COLLEAGUES_MERCHANT_GROUP));
}

/**
 * A group of people: «Особи і ФОП» (stable key `persons`) or, since P8
 * stage 11, «Колеги» (`colleagues`). Everything that keeps people apart
 * (never merged automatically, no website, no autopilot) applies to both.
 */
export function isPersonsMerchantGroup(group: string | null | undefined, code?: string | null): boolean {
  return code === "persons" || (group != null && iso(group) === iso(PERSONS_MERCHANT_GROUP)) || isColleaguesMerchantGroup(group, code);
}

const isPersonType = (t: PayeeType) => t === "person" || t === "sole_proprietor";

/**
 * The entity type for a new or edited entry: «Колеги» → person; «Особи і ФОП» → person (or
 * sole_proprietor when the name says ФОП); a person-looking name keeps its
 * person type; otherwise the guess, then the group's obvious type, then
 * retail. Without a merchant type the guess is returned unchanged.
 */
export function payeeTypeForMerchantType(merchantGroup: string | null | undefined, guess: PayeeType): PayeeType {
  // Colleagues are private persons, never ФОП.
  if (isColleaguesMerchantGroup(merchantGroup)) return "person";
  if (isPersonsMerchantGroup(merchantGroup)) return isPersonType(guess) ? guess : "person";
  if (isPersonType(guess) || !merchantGroup) return guess;
  if (guess !== "other") return guess;
  return GROUP_TYPE[iso(merchantGroup)] ?? "retail";
}
