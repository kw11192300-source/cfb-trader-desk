import { timingSafeEqual } from "node:crypto";
import { triggerNhlRefresh } from "@/lib/actions";

// Starts the full NHL model refresh (the GitHub Actions workflow behind the "Refresh model" button) on a schedule. Call it
// from cron-job.org a couple of times a day - e.g. 11:00 and 17:00 Eastern, so lineups and goalie news are in before puck
// drop. Exempt from the site password (src/proxy.ts) like the odds timer, and guarded by the same CRON_SECRET: send it as
// `Authorization: Bearer <secret>` or `?key=<secret>`. If a refresh is already running this does nothing.
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

  const r = await triggerNhlRefresh();
  // "already running" is the expected no-op, not a failure the scheduler should retry or alarm on
  const alreadyRunning = !r.ok && /already running/i.test(r.message);
  return Response.json({ ...r, skipped: alreadyRunning }, { status: r.ok || alreadyRunning ? 200 : 502 });
}
