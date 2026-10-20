import { supabaseAdmin } from "./supabase-admin";

// Server-only. Starts the NBA live-projection job (.github/workflows/nba-live.yml: projected minutes, stat lines and the injury news
// move for the games coming up) when the injury report CHANGED, and as a fallback when the last projections are over 90 minutes old
// and a game is within ~36 hours. Called from the ~10-minute NBA timer (nbaOdds.ts), so the projections follow the report without
// anyone pressing a button. A run takes a few minutes; runs never overlap (the workflow queues at most one behind the current one).

const GITHUB_REPO = "kw11192300-source/cfb-trader-desk";

export async function maybeRunNbaLive(injuryChanges: number): Promise<string> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return "";
  const now = Date.now();
  const { data: soon, error } = await supabaseAdmin
    .from("games")
    .select("id")
    .eq("sport", "nba")
    .eq("completed", false)
    .gt("start_date", new Date(now).toISOString())
    .lt("start_date", new Date(now + 36 * 3_600_000).toISOString())
    .limit(1);
  if (error || !soon?.length) return "";
  const { data: last, error: lastErr } = await supabaseAdmin.from("nba_game_projections").select("computed_at").order("computed_at", { ascending: false }).limit(1);
  if (lastErr) return ""; // table not created yet
  const ageMin = last?.[0] ? (now - new Date(last[0].computed_at as string).getTime()) / 60_000 : Infinity;
  if (ageMin < 8) return "";
  if (injuryChanges === 0 && ageMin < 90) return "";
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/nba-live.yml/dispatches`, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  return res.status === 204 ? "Projections refresh started." : "";
}
