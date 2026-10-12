/**
 * Merchant profile fields (Payee Studio P5c): website and logo.
 *
 * Website: only http / https; stored normalized as `https://host/path`
 * (scheme forced to https, host lower-cased, credentials, port, query and
 * fragment dropped, trailing slash trimmed). Rendered with
 * `rel="noopener noreferrer nofollow" target="_blank"`.
 *
 * Logo: a `data:` URI of a PNG, JPEG or WebP image, ≤ LOGO_MAX_BYTES decoded,
 * whose magic bytes match its declared type. SVG (scriptable) and anything
 * else is refused. Both are stored encrypted (user DEK). The server never
 * fetches a site or a favicon: the user or their AI client supplies them.
 */
import { PayeeDirectoryError } from "./directory";

export const LOGO_MAX_BYTES = 20 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

/** Normalize a website to `https://host/path`, or throw a plain-language error. */
export function normalizeWebsite(raw: string): string {
  const v = raw.trim();
  if (!v) throw new PayeeDirectoryError("The website can't be empty.");
  if (v.length > 500) throw new PayeeDirectoryError("The website address is too long.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v.replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new PayeeDirectoryError(`“${v}” is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PayeeDirectoryError("Only http and https websites are allowed.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new PayeeDirectoryError(`“${v}” is not a public website address.`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `https://${host}${path}`;
}

function detectImage(bytes: Uint8Array): LogoType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Validate a logo data URI; returns it in canonical `data:<type>;base64,<…>` form. */
export function normalizeLogo(raw: string): string {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw.trim());
  if (!m) throw new PayeeDirectoryError("The logo must be a PNG, JPEG or WebP image (data: URI, base64).");
  const declared = m[1].toLowerCase().replace("image/jpg", "image/jpeg");
  if (declared === "image/svg+xml") throw new PayeeDirectoryError("SVG logos are not allowed; use PNG, JPEG or WebP.");
  if (!(LOGO_TYPES as readonly string[]).includes(declared)) throw new PayeeDirectoryError("The logo must be a PNG, JPEG or WebP image.");
  const b64 = m[2].replace(/\s+/g, "");
  if (b64.length > Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 4) throw new PayeeDirectoryError(`The logo is too large (${Math.round(LOGO_MAX_BYTES / 1024)} KB max).`);
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  if (bytes.length === 0) throw new PayeeDirectoryError("The logo is empty.");
  if (bytes.length > LOGO_MAX_BYTES) throw new PayeeDirectoryError(`The logo is too large (${Math.round(LOGO_MAX_BYTES / 1024)} KB max).`);
  const actual = detectImage(bytes);
  if (!actual) throw new PayeeDirectoryError("The logo file is not a PNG, JPEG or WebP image.");
  if (actual !== declared) throw new PayeeDirectoryError(`The logo says ${declared} but the file is ${actual}.`);
  return `data:${actual};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Split a stored logo into its type and bytes (for GET /api/payees/[id]/logo). */
export function decodeLogo(dataUri: string): { type: LogoType; bytes: Buffer } | null {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUri);
  if (!m) return null;
  const bytes = Buffer.from(m[2], "base64");
  return detectImage(bytes) === m[1] ? { type: m[1] as LogoType, bytes } : null;
}
