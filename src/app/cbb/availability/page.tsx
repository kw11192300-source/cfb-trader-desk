import CbbAvailabilityForm, { type PlayerOption, type TeamOption } from "@/components/CbbAvailabilityForm";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCbbAvailability, getCbbPlayers, getCbbRatings } from "@/lib/data";

export const dynamic = "force-dynamic";

const SEASON = 2026;

export default async function CbbAvailabilityPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const p = await searchParams;
  const teamId = p.team && Number.isFinite(Number(p.team)) ? Number(p.team) : null;
  const [ratings, players, current] = await Promise.all([
    getCbbRatings(SEASON, "preseason"),
    teamId ? getCbbPlayers({ season: SEASON, teamId, limit: 40 }) : Promise.resolve([]),
    getCbbAvailability(SEASON),
  ]);
  const teams: TeamOption[] = ratings.map((r) => ({ id: r.team_id, name: String(r.stats.school ?? r.team) })).sort((a, b) => a.name.localeCompare(b.name));
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const roster: PlayerOption[] = players
    .map((pl) => {
      const floor = num(pl.stats.proj_floor);
      return {
        id: pl.player_id,
        name: pl.name,
        f: floor !== null ? floor / 20 : 0.25,
        v: num(pl.stats.proj_net) ?? 0,
        mpg: num(pl.stats.proj_mpg),
        role: typeof pl.stats.role === "string" ? pl.stats.role : null,
      };
    })
    .sort((a, b) => (b.mpg ?? 0) - (a.mpg ?? 0));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Availability" sport="cbb" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-6">
        <CbbAvailabilityForm season={SEASON} teams={teams} teamId={teamId} roster={roster} current={current} />
      </main>
      <SiteFooter />
    </div>
  );
}
