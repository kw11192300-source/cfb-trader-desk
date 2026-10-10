import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { updateNhlOdds, updateNhlScores } from "@/lib/nhlOdds";

// Called on a timer (every ~10 minutes) by an outside scheduler - cron-job.org, or Vercel Cron on a plan that allows
// that frequency. It is exempt from the site password (src/proxy.ts) because a timer can't log in, so it checks its own
// secret instead: send CRON_SECRET as `Authorization: Bearer <secret>` (what Vercel Cron sends) or as `?key=<secret>`.
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // unset: open in local dev, closed in production
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

  // scores first, so the grading at the end of the odds update already sees anything that just went final
  const scores = await updateNhlScores();
  const result = await updateNhlOdds();
  if (result.ok) {
    revalidatePath("/nhl");
    revalidatePath("/nhl/edges");
    revalidatePath("/nhl/bets");
    revalidatePath("/nhl/performance");
  }
  return Response.json({ ...result, scores }, { status: result.ok ? 200 : 502 });
}
