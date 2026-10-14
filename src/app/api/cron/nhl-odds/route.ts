import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sendGameAlerts } from "@/lib/nhlGameAlerts";
import { testTelegram, updateNhlOdds, updateNhlScores } from "@/lib/nhlOdds";

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

  // `?alerts=dry` shows the puck-drop / final messages that would go out, without sending or recording anything
  if (new URL(request.url).searchParams.get("alerts") === "dry") {
    return Response.json(await sendGameAlerts({ dry: true }));
  }

  // `?telegram=test` just sends a test message (to confirm the bot setup) and skips the update
  if (new URL(request.url).searchParams.get("telegram") === "test") {
    const t = await testTelegram();
    return Response.json(t, { status: t.ok ? 200 : 502 });
  }

  // scores first, so the grading at the end of the odds update already sees anything that just went final
  const scores = await updateNhlScores();
  const result = await updateNhlOdds();
  // puck-drop and final messages for games you have bets on (after the update, so scores and prices are fresh)
  const gameAlerts = await sendGameAlerts().catch(() => ({ pregame: 0, final: 0 }));
  if (result.ok) {
    revalidatePath("/nhl");
    revalidatePath("/nhl/edges");
    revalidatePath("/nhl/bets");
    revalidatePath("/nhl/performance");
  }
  return Response.json({ ...result, scores, gameAlerts }, { status: result.ok ? 200 : 502 });
}
