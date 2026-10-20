import { timingSafeEqual } from "node:crypto";
import { updateNba } from "@/lib/nbaOdds";

// NBA: keeps the schedule/scores current, logs every line move to nba_odds_snapshots and grades prop bets from box scores. Called on a timer
// (every ~10 minutes) by cron-job.org, exempt from the site password (src/proxy.ts) and guarded by the same CRON_SECRET as
// the NHL timer: `Authorization: Bearer <secret>` or `?key=<secret>`.
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
  const r = await updateNba({ grade: true });
  return Response.json(r, { status: r.ok ? 200 : 502 });
}
