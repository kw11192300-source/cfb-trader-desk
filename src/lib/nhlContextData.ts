import { getNhlStatSeasons, getNhlTeamStats } from "./data";
import { EMPTY_CONTEXT, type Injury, type InjuryStatus, type NhlContext } from "./nhlContext";
import { espnCode } from "./nhlTeams";
import { supabase } from "./supabase";

const ESPN_INJURIES = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries";

type EspnInjury = {
  status?: string;
  date?: string;
  shortComment?: string;
  athlete?: { displayName?: string; position?: { abbreviation?: string } };
  details?: { type?: string; returnDate?: string };
};

function normalizeStatus(s: string | undefined): InjuryStatus | null {
  if (!s) return null;
  if (/day/i.test(s)) return "Day-To-Day";
  if (/reserve|^ir$/i.test(s)) return "IR";
  if (/suspen/i.test(s)) return "Suspension";
  if (/out/i.test(s)) return "Out";
  return null;
}

/** ESPN's league-wide injury list, keyed by team code. Cached for 10 minutes; an outage just means "no injury info". */
async function fetchInjuries(): Promise<Record<string, Injury[]>> {
  try {
    const res = await fetch(ESPN_INJURIES, { next: { revalidate: 600 } });
    if (!res.ok) return {};
    const data = (await res.json()) as { injuries?: { displayName?: string; injuries?: EspnInjury[] }[] };
    const out: Record<string, Injury[]> = {};
    for (const t of data.injuries ?? []) {
      const code = t.displayName ? espnCode(t.displayName) : null;
      if (!code) continue;
      out[code] = (t.injuries ?? []).flatMap((i) => {
        const status = normalizeStatus(i.status);
        if (!status || !i.athlete?.displayName) return [];
        return [
          {
            name: i.athlete.displayName,
            position: i.athlete.position?.abbreviation ?? null,
            status,
            type: i.details?.type ?? null,
            date: i.date ?? "",
            returnDate: i.details?.returnDate ?? null,
            comment: i.shortComment ?? null,
          },
        ];
      });
    }
    return out;
  } catch {
    return {};
  }
}

/** Everything the model doesn't know that we can look up for free: injuries, who played last night, and how many games each
 * team has actually played. Never throws - a failure just leaves that part empty. */
export async function getNhlContext(): Promise<NhlContext> {
  try {
    const now = Date.now();
    const from = new Date(now - 10 * 86400000).toISOString();
    const to = new Date(now + 10 * 86400000).toISOString();
    const [injuries, sched, seasons] = await Promise.all([
      fetchInjuries(),
      supabase.from("games").select("home_team, away_team, start_date").eq("sport", "nhl").gte("start_date", from).lte("start_date", to),
      getNhlStatSeasons().catch(() => ({ seasons: [] as number[], hasL10: {} })),
    ]);
    const starts: Record<string, string[]> = {};
    for (const g of sched.data ?? []) {
      for (const team of [g.home_team as string, g.away_team as string]) (starts[team] ??= []).push(g.start_date as string);
    }
    for (const k of Object.keys(starts)) starts[k].sort();

    const gp: Record<string, number> = {};
    if (seasons.seasons.length > 0) {
      for (const r of await getNhlTeamStats(seasons.seasons[0], "all")) {
        if (r.name && typeof r.stats.gp === "number") gp[r.name] = r.stats.gp;
      }
    }
    return { injuries, starts, gp };
  } catch {
    return EMPTY_CONTEXT;
  }
}
