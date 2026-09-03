import "server-only";

// Single shared-password gate for the whole site (src/middleware.ts) - not
// per-user accounts, this is a personal single-user app. The raw password
// is compared server-side only and NEVER stored anywhere client-visible;
// the cookie holds SHA-256(a fixed label + the password), not the password
// itself, so even reading your own browser's cookie storage doesn't reveal
// it, and the label prevents it just being a bare, rainbow-table-able
// SHA-256(password). Uses Web Crypto (crypto.subtle) rather than Node's
// `crypto` module so the exact same code works in both the Node-runtime
// login Server Action and the Edge-runtime middleware.
const SITE_PASSWORD = process.env.SITE_PASSWORD;

export const COOKIE_NAME = "site_auth";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The cookie value a successful login sets, and what middleware checks
 * incoming requests against. Returns null if SITE_PASSWORD isn't
 * configured at all - middleware treats that as "gate disabled" rather
 * than locking everyone out of an unconfigured deployment. */
export async function expectedCookieValue(): Promise<string | null> {
  if (!SITE_PASSWORD) return null;
  return sha256Hex(`cfb-trader-desk-site-auth:${SITE_PASSWORD}`);
}

export function checkPassword(candidate: string): boolean {
  return Boolean(SITE_PASSWORD) && candidate === SITE_PASSWORD;
}
