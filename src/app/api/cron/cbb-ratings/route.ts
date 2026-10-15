import { timingSafeEqual } from "node:crypto";
import { triggerCbbRatings } from "@/lib/actions";

// Refits the college basketball ratings from the season so far and rescores the board (the GitHub Actions job takes a few minutes). Call it from cron-job.org
// every 3-4 hours. Exempt from the site password (src/proxy.ts) like the odds timer and guarded by the same
// CRON_SECRET: `Authorization: Bearer <secret>` or `?key=<secret>`.
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const url = new URL(request.url);
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("key") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production" && !process.env.CRON_SECRET) {
    return Response.json({ ok: false, message: "CRON_SECRET is not set on the server." }, { status: 500 });
  }
  if (!authorized(request)) return Response.json({ ok: false, message: "Unauthorized." }, { status: 401 });
  const r = await triggerCbbRatings();
  return Response.json(r, { status: r.ok ? 200 : 502 });
}
