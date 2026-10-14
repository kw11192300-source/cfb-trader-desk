import Link from "next/link";
import CbbLogo from "@/components/CbbLogo";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCbbPlayers, getCbbRatings } from "@/lib/data";

export const dynamic = "force-dynamic";

const SEASON = 2026;
const ROLES = [
  ["", "All players"],
  ["returner", "Returners"],
  ["transfer", "Transfers"],
  ["newcomer", "No D1 history"],
  ["freshman", "Freshmen (entered)"],
  ["international", "Internationals (entered)"],
];

const n = (v: unknown, d = 1): string => (typeof v === "number" ? v.toFixed(d) : "—");
const sg = (v: unknown, d = 1): string => (typeof v === "number" ? `${v > 0 ? "+" : ""}${v.toFixed(d)}` : "—");
const pc = (v: unknown): string => (typeof v === "number" ? `${(v * 100).toFixed(0)}` : "—");
const tone = (v: unknown) => (typeof v === "number" ? (v > 0.05 ? "text-up" : v < -0.05 ? "text-down" : "text-foreground") : "text-muted");
const short = (c: string | null) => (c ?? "").replace(/ Conference$/, "");

const fmtHt = (h: unknown) => (typeof h === "number" ? `${Math.floor(h / 12)}'${Math.round(h % 12)}"` : "—");

export default async function CbbPlayersPage({ searchParams }: { searchParams: Promise<{ conf?: string; role?: string; q?: string }> }) {
  const p = await searchParams;
  const conferences = [...new Set((await getCbbRatings(SEASON, "preseason")).map((r) => r.conference).filter((c): c is string => Boolean(c)))].sort();
  const players = await getCbbPlayers({ season: SEASON, conference: p.conf || undefined, role: p.role || undefined, q: p.q || undefined, limit: 300 });

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Players" sport="cbb" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-4 max-w-4xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Every player on a Division I roster for 2026-27, ranked by <span className="text-foreground">impact</span> - projected rating times the share of his
            team&apos;s floor time he is expected to play. <span className="text-foreground">Rating</span> is points per 100 possessions a team gains with him on
            the floor versus an average player (offence minus defence), built from lineup data: how each team actually performed with him in and out, adjusted for
            teammates and opponents, shrunk toward what his box-score line predicts. It isn&apos;t a counting stat - a big man&apos;s rebounds only count for what
            they are worth.
          </p>
          <p className="mt-2">
            Players with no Division I history (freshmen, internationals, pros) show a default value until they play, or a number entered by hand. Rosters are ESPN&apos;s
            and still filling in - incoming transfers and signees appear as schools announce them.
          </p>
        </div>

        <form method="get" className="mb-3 flex flex-wrap items-center gap-2">
          <input
            name="q"
            defaultValue={p.q ?? ""}
            placeholder="Search a player…"
            className="w-48 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <select name="conf" defaultValue={p.conf ?? ""} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none">
            <option value="">All conferences</option>
            {conferences.map((c) => (
              <option key={c} value={c}>
                {short(c)}
              </option>
            ))}
          </select>
          <select name="role" defaultValue={p.role ?? ""} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none">
            {ROLES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background hover:opacity-90">
            Filter
          </button>
          <span className="text-xs text-muted">top {players.length} by impact</span>
        </form>

        {players.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
            No players match - or the ratings have not been published yet (<code className="text-foreground">python -m cbb_model.players_table</code>).
          </div>
        ) : (
          <div className="max-h-[78vh] overflow-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="sticky top-0 z-10 w-8 bg-surface-raised px-2 py-2.5 text-right font-medium">#</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Player</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Team</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-2 py-2.5 font-medium">Cl</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-2 py-2.5 font-medium">Ht</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium" title="Impact = Rating x share of the game he is on the floor (MPG / 40). Rating is how good he is per possession; impact is how much he moves his TEAM, so a great bench player ranks below a great starter.">Impact</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium" title="Projected rating, points per 100 possessions vs an average player">Rating</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">Off</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium" title="Points per 100 allowed (lower is better)">Def</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium" title="Projected minutes per game (a team has 200 to hand out: five players for 40 minutes)">Proj MPG</th>
                  <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-3 py-2.5 text-right font-medium">MPG</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">PPG</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">RPG</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">APG</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">TS%</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">3P%</th>
                  <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Role</th>
                </tr>
              </thead>
              <tbody>
                {players.map((r, i) => {
                  const s = r.stats;
                  const net = s.proj_net;
                  const lastOff = s.last_off;
                  const lastDef = s.last_def;
                  const role = String(s.role ?? "");
                  return (
                    <tr key={r.player_id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                      <td className="px-2 py-1.5 text-right font-mono text-muted">{i + 1}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-foreground">{r.name}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <Link href={`/cbb/teams/${r.team_id}`} prefetch={false} className="flex items-center gap-1.5 text-foreground hover:underline">
                          <CbbLogo teamId={r.team_id} size={16} />
                          {String(r.stats.school ?? r.team)}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 text-muted">{(s.class as string) ?? ""}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-muted">{fmtHt(s.height)}</td>
                      <td className={`px-3 py-1.5 text-right font-mono font-semibold ${tone(r.impact)}`}>{sg(r.impact, 2)}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${tone(net)}`}>{sg(net, 1)}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${tone(lastOff)}`}>{sg(lastOff, 1)}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${typeof lastDef === "number" ? (lastDef < -0.05 ? "text-up" : lastDef > 0.05 ? "text-down" : "text-foreground") : "text-muted"}`}>{sg(lastDef, 1)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.proj_mpg, 1)}</td>
                      <td className="border-l border-border px-3 py-1.5 text-right font-mono text-foreground">{n(s.mpg)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.ppg)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.rpg)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.apg)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-foreground">{pc(s.ts_pct)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-foreground">{pc(s.tp_pct)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-muted">
                        {role === "transfer" ? `from ${String(s.prev_team ?? "")}` : role}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Off and Def are last season&apos;s measured offence and defence (points per 100 possessions, lineup-based where available). Rating is the projection for 2026-27 after
          regression to the mean and, for transfers, the move. Per-game columns are last season&apos;s line.
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
