import NhlTeamLog from "@/components/NhlTeamLog";
import NhlTeamPicker from "@/components/NhlTeamPicker";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getNhlTeamGames, getNhlTeamNames } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function NhlSchedulePage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const { team } = await searchParams;
  const teams = await getNhlTeamNames();
  const current = team && teams.includes(team) ? team : null;
  const rows = current ? await getNhlTeamGames(current) : [];

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Schedule" sport="nhl" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Pick a team to see its whole season game by game: the <span className="text-foreground">actual</span> result and chances, what{" "}
            <span className="text-foreground">our model</span> expected before the game, and where <span className="text-foreground">DraftKings closed</span> - plus how
            the game fell against those prices. Use the filters for recent form; the same log (last 5) sits at the bottom of every game page.
          </p>
        </div>

        <NhlTeamPicker teams={teams} current={current} />
        {current && <NhlTeamLog rows={rows} />}
      </main>

      <SiteFooter />
    </div>
  );
}
