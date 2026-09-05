import MyGameCard from "@/components/MyGameCard";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getBets, type GradedBet } from "@/lib/data";
import { supabase } from "@/lib/supabase";
import type { Game } from "@/lib/types";

export const dynamic = "force-dynamic";

// Games kick off, run ~3-4h, then this page has done its job (the
// permanent record lives on /bets) - keep a finished game visible for a
// day afterward so the final result is still there right after it wraps,
// then let it drop off instead of this turning into a second ledger.
const RECENT_MS = 24 * 60 * 60 * 1000;

export default async function MyGamesPage() {
  const allBets = await getBets();
  const now = Date.now();

  const byGame = new Map<number, { game: Game; bets: GradedBet[] }>();
  for (const gb of allBets) {
    const game = gb.game;
    if (!game) continue;
    const kickoff = new Date(game.start_date).getTime();
    const relevant = !game.completed || now - kickoff < RECENT_MS;
    if (!relevant) continue;
    const entry = byGame.get(game.id) ?? { game, bets: [] as GradedBet[] };
    entry.bets.push(gb);
    byGame.set(game.id, entry);
  }
  const rows = Array.from(byGame.values()).sort((a, b) => new Date(a.game.start_date).getTime() - new Date(b.game.start_date).getTime());

  const schools = Array.from(new Set(rows.flatMap((r) => [r.game.home_team, r.game.away_team])));
  const { data: teams } = schools.length > 0 ? await supabase.from("teams").select("school, logo_url").in("school", schools) : { data: [] };
  const logoBySchool = new Map((teams ?? []).map((t) => [t.school as string, t.logo_url as string | null]));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="My Games" />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
            No upcoming or live games with a logged pick right now — see <span className="text-foreground">Bets</span> for the full history.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map(({ game, bets }) => (
              <MyGameCard key={game.id} game={game} bets={bets} homeLogo={logoBySchool.get(game.home_team) ?? null} awayLogo={logoBySchool.get(game.away_team) ?? null} />
            ))}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
