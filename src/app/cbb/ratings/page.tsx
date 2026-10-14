import Link from "next/link";
import CbbRatingsTable, { type CbbRatingRow } from "@/components/CbbRatingsTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCbbRatingKinds, getCbbRatings } from "@/lib/data";

export const dynamic = "force-dynamic";

const logo = (id: number) => `https://a.espncdn.com/i/teamlogos/ncaa/500/${id}.png`;
const shortConf = (c: string | null) => (c ?? "").replace(/ Conference$/, "");

export default async function CbbRatingsPage({ searchParams }: { searchParams: Promise<{ season?: string; kind?: string }> }) {
  const p = await searchParams;
  const kinds = await getCbbRatingKinds();
  const chosen = kinds.find((k) => String(k.season) === p.season && k.kind === p.kind) ?? kinds[0] ?? null;
  const ratings = chosen ? await getCbbRatings(chosen.season, chosen.kind) : [];

  const rows: CbbRatingRow[] = ratings.map((r) => ({
    id: r.team_id,
    label: r.team,
    sub: r.kind === "preseason" && r.stats.coach ? `${shortConf(r.conference)} · ${String(r.stats.coach)}` : shortConf(r.conference),
    logo: logo(r.team_id),
    conference: shortConf(r.conference),
    stats: Object.fromEntries(Object.entries(r.stats).map(([k, v]) => [k, typeof v === "number" ? v : null])),
  }));
  const conferences = [...new Set(rows.map((r) => r.conference).filter(Boolean))].sort();
  const label = (k: { season: number; kind: string }) => (k.kind === "preseason" ? `${k.season}-${String((k.season + 1) % 100).padStart(2, "0")} preseason` : `${k.season}-${String((k.season + 1) % 100).padStart(2, "0")} final`);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Team ratings" sport="cbb" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Adjusted efficiency for every Division I team, the way KenPom and Barttorvik rate them: <span className="text-foreground">Off</span> and{" "}
            <span className="text-foreground">Def</span> are points per 100 possessions against an average opponent on a neutral floor, <span className="text-foreground">Net</span>{" "}
            is the gap, and <span className="text-foreground">Tempo</span> is possessions per 40 minutes relative to average.
          </p>
          <p className="mt-2">
            The <span className="text-foreground">preseason</span> view is our roster-based projection for the coming season: last season&apos;s rating, who is back,
            who transferred in and what each did last year, and how experienced the group is - trained on every season since 2019 and tested against the real
            closing lines. It is a projection, not a result; ratings switch to in-season numbers once games are played.
          </p>
        </div>

        {kinds.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {kinds.map((k) => {
              const on = chosen && k.season === chosen.season && k.kind === chosen.kind;
              return (
                <Link
                  key={`${k.season}-${k.kind}`}
                  href={`/cbb/ratings?season=${k.season}&kind=${k.kind}`}
                  className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${on ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`}
                >
                  {label(k)}
                </Link>
              );
            })}
          </div>
        )}

        {chosen === null ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
            No ratings published yet - run <code className="text-foreground">python -m cbb_model.publish ratings</code>.
          </div>
        ) : (
          <CbbRatingsTable rows={rows} kind={chosen.kind} conferences={conferences} />
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
