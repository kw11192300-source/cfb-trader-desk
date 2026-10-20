import Link from "next/link";
import LogParlayForm from "@/components/LogParlayForm";
import NbaGameCard from "@/components/NbaGameCard";
import NbaModelButton from "@/components/NbaModelButton";
import NbaScoresButton from "@/components/NbaScoresButton";
import NhlBetStrip from "@/components/NhlBetStrip";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets, getNbaGames, getNbaInjuries, getNbaPlayers, getNbaProjections, getNbaSnapshots } from "@/lib/data";
import { PROPS } from "@/lib/nbaPropCatalog";
import { etDay } from "@/lib/nhlTeamGames";

export const dynamic = "force-dynamic";

const dayLabel = (day: string, today: string) => (day === today ? "Today" : new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }));
const shiftDay = (day: string, n: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export default async function NbaPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const p = await searchParams;
  const today = etDay(new Date().toISOString());
  const day = p.day && /^\d{4}-\d{2}-\d{2}$/.test(p.day) ? p.day : today;
  // an Eastern-time day spans 04:00-05:00 UTC to the same time next day; fetch a little wide and filter on the Eastern date
  const from = new Date(new Date(`${day}T00:00:00Z`).getTime() - 2 * 3_600_000).toISOString();
  const to = new Date(new Date(`${day}T00:00:00Z`).getTime() + 31 * 3_600_000).toISOString();
  const [rawGames, allBets] = await Promise.all([getNbaGames(from, to), getBets()]);
  const games = rawGames.filter((g) => etDay(g.start_date) === day);
  const [snaps, injuries, players, projections] = await Promise.all([getNbaSnapshots(games.map((g) => g.id)), getNbaInjuries(day), getNbaPlayers(2026), getNbaProjections(games.map((g) => g.id))]);
  const nameKey = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
  const ratings: Record<string, number> = {};
  for (const p of players) if (p.net !== null) ratings[nameKey(p.name)] = p.net;
  const nbaBets = allBets.filter((b) => b.bet.sport === "nba");
  const days = [-2, -1, 0, 1, 2, 3, 4].map((n) => shiftDay(today, n));
  const auto = PROPS.filter((x) => x.auto).map((x) => x.label);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Board" sport="nba" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <NbaScoresButton />
        <NbaModelButton updatedAt={[...projections.games.values()].map((g) => g.computed_at).sort().at(-1) ?? null} />
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          Log every NBA bet here: spread, moneyline and total on each game, plus player props. Spread, ML and total grade themselves from the final score.{" "}
          <span className="text-foreground">Player props grade themselves too</span> from ESPN&apos;s box score once the game is final - type the player and pick the
          market ({auto.slice(0, 6).join(", ")}, combos like Pts + Reb + Ast, shooting lines, double-double / triple-double and more); a player who doesn&apos;t play voids
          the bet. Markets the box score can&apos;t settle (first basket, quarter and half lines, team props) stay pending for you to settle on the Bets page.
        </div>

        <div className="mb-4">
          <NhlBetStrip bets={allBets} today={today} sport="nba" />
        </div>
        <div className="mb-4">
          <LogParlayForm sport="nba" />
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {days.map((d) => (
            <Link
              key={d}
              href={d === today ? "/nba" : `/nba?day=${d}`}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${d === day ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`}
            >
              {dayLabel(d, today)}
            </Link>
          ))}
        </div>

        {games.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
            No NBA games for this day yet. Games appear once the timer has run ({" "}
            <span className="text-foreground">/api/cron/nba-odds</span> every ~10 minutes) - or press Update scores.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {games.map((g) => (
              <NbaGameCard key={g.id} game={g} snaps={snaps.get(g.id) ?? []} bets={nbaBets} injuries={injuries.filter((i) => i.team === g.home_team || i.team === g.away_team)} ratings={ratings} projection={projections.games.get(g.id)} />
            ))}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
