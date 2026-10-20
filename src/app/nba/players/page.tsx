import NbaPlayersTable, { type NbaPlayerRow } from "@/components/NbaPlayersTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNbaPlayers } from "@/lib/data";
import { nbaLogo } from "@/lib/nbaTeams";

export const dynamic = "force-dynamic";

const SEASON = 2026;

export default async function NbaPlayersPage() {
  const players = await getNbaPlayers(SEASON);
  const rows: NbaPlayerRow[] = players.map((p) => {
    const s = p.stats;
    const inj = typeof s.injury === "string" && s.injury ? ` · ${s.injury}` : "";
    const meta = [typeof s.pos === "string" ? s.pos : null, typeof s.age === "number" ? `${s.age}` : null].filter(Boolean).join(" · ");
    return {
      id: p.player_id,
      label: p.name,
      sub: `${p.team ?? "—"}${meta ? ` · ${meta}` : ""}${inj}`,
      logo: p.team ? nbaLogo(p.team) : null,
      team: p.team ?? "",
      stats: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "number" ? v : null])),
    };
  });
  const teams = [...new Set(rows.map((r) => r.team).filter(Boolean))].sort();
  const through = players[0] && typeof players[0].stats.through === "string" ? String(players[0].stats.through) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Player value" sport="nba" />
      <main className="mx-auto w-full max-w-[1500px] flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            A stats-only player rating in the family of EPM, DARKO and BPM, built from public data: every lineup that has been on the floor (rebuilt from play-by-play),
            plus each player&apos;s box-score line. <span className="text-foreground">Net</span> is the points per 100 possessions he adds over an average player while on the floor,
            split into <span className="text-foreground">Off</span> and <span className="text-foreground">Def</span> (positive Def = his team allows fewer points). On this scale
            stars are +6 and up and a lineup of five +1 players is +5.
          </p>
          <p className="mt-2">
            <span className="text-foreground">Out: Spread / Total / Pace</span> is what his team has actually done without him, which is the number to reach for when a player is ruled
            out (a missing rotation player costs a team about 2 points, a star a bit more; most absences barely move the total). The <span className="text-foreground">G out</span> column
            says how much evidence sits behind it.
          </p>
          <p className="mt-2">
            Limits: defence is the hardest thing to measure without tracking data, so read Def with the <span className="text-foreground">Poss</span> column (players below ~4,000 possessions lean
            on their box-score line). Ratings use games through {through ?? "the last finished season"} until this season has enough games to update them, and rookies aren&apos;t rated
            yet. Tested out of sample, the ratings predict game margin with a 0.41 correlation given the lineups.
          </p>
        </div>
        <NbaPlayersTable rows={rows} teams={teams} />
      </main>
      <SiteFooter />
    </div>
  );
}
