/**
 * Tag-list helpers for the comma-separated `tags` text stored on transactions
 * (and on staged imports / splits).
 *
 * Storage format: tags joined by a bare comma, no space (`"travel,work"`) —
 * the shape every importer writes (`tags.join(",")` in the connectors) and
 * the one the MCP bulk append/remove path always produced. Readers split on
 * `,` and trim, so legacy values written with `", "` still parse.
 *
 * Tag identity is `normalizeForMatch` (case, apostrophes, Unicode NFC, dashes,
 * whitespace): `Agrotrade`, `agrotrade ` and `AGROTRADE` are one tag. When two
 * spellings collide, the FIRST one wins — an existing tag is never re-spelled
 * by adding a variant of it, and existing tags keep their order (new ones go
 * at the end).
 *
 * Pure functions only: safe to import from client components. The DB writer
 * that applies these to stored rows is `lib/transactions/rewrite-tags.ts`.
 */
import { normalizeForMatch } from "./text-normalize";

/** The separator tags are joined with in stored values. */
export const TAG_SEPARATOR = ",";

/** Comparison key for a tag (see module docstring). */
export function tagKey(tag: string): string {
  return normalizeForMatch(tag);
}

/**
 * Accepts a stored tag string, a user-typed comma list, or an array (whose
 * items may themselves be comma lists) and returns the trimmed, non-empty
 * tags, deduplicated by {@link tagKey} with the first spelling kept.
 */
export function toTagList(input: string | readonly string[] | null | undefined): string[] {
  if (input == null) return [];
  const raw = typeof input === "string" ? [input] : input;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of raw) {
    if (typeof chunk !== "string") continue;
    for (const part of chunk.split(TAG_SEPARATOR)) {
      const t = part.trim();
      if (!t) continue;
      const k = tagKey(t);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** Parse a stored tag string into its tags (trimmed, no empties, deduplicated). */
export function parseTags(str: string | null | undefined): string[] {
  return toTagList(str);
}

/** Join tags into the stored form. Trims, drops empties, deduplicates. */
export function formatTags(list: readonly string[]): string {
  return toTagList(list).join(TAG_SEPARATOR);
}

/**
 * Add `toAdd` to the stored tag string. Tags already present (by
 * {@link tagKey}) are skipped; new ones are appended in the order given.
 * When nothing is added the input comes back unchanged (`null` → `""`), so a
 * caller can skip the write with `next === (current ?? "")`.
 */
export function addTags(
  str: string | null | undefined,
  toAdd: string | readonly string[] | null | undefined,
): string {
  const current = parseTags(str);
  const keys = new Set(current.map(tagKey));
  const added: string[] = [];
  for (const t of toTagList(toAdd)) {
    const k = tagKey(t);
    if (keys.has(k)) continue;
    keys.add(k);
    added.push(t);
  }
  if (added.length === 0) return str ?? "";
  return formatTags([...current, ...added]);
}

/**
 * Remove every tag matching one of `toRemove` (by {@link tagKey}). Order of
 * the remaining tags is kept. Unchanged input comes back as-is (`null` → `""`).
 */
export function removeTags(
  str: string | null | undefined,
  toRemove: string | readonly string[] | null | undefined,
): string {
  const drop = new Set(toTagList(toRemove).map(tagKey));
  if (drop.size === 0) return str ?? "";
  const current = parseTags(str);
  const kept = current.filter((t) => !drop.has(tagKey(t)));
  if (kept.length === current.length) return str ?? "";
  return formatTags(kept);
}

/**
 * Replace every tag matching one of `from` with `to`, in place. Each match
 * becomes `to`, then duplicates collapse with the first position winning — so
 * if the row already carried `to` earlier, that occurrence (and its spelling)
 * stays and the replaced one disappears. This is rename and merge in one:
 * renaming onto an existing tag merges.
 * Unchanged input comes back as-is (`null` → `""`).
 */
export function replaceTags(
  str: string | null | undefined,
  from: string | readonly string[],
  to: string,
): string {
  const fromKeys = new Set(toTagList(from).map(tagKey));
  const target = to.trim();
  if (fromKeys.size === 0 || !target) return str ?? "";
  const current = parseTags(str);
  if (!current.some((t) => fromKeys.has(tagKey(t)))) return str ?? "";
  const next = formatTags(current.map((t) => (fromKeys.has(tagKey(t)) ? target : t)));
  // A pure respelling of the target onto itself (e.g. "agrotrade " → "Agrotrade")
  // is a real change; an identical result is not.
  return next === (str ?? "") ? str ?? "" : next;
}

/** True when the row carries at least one tag. */
export function hasAnyTag(str: string | null | undefined): boolean {
  return parseTags(str).length > 0;
}
