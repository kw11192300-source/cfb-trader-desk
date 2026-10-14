import Link from "next/link";
import { notFound } from "next/navigation";
import CbbLogo from "@/components/CbbLogo";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCbbPlayers, getCbbRatingsFor, getCbbTeamRatings } from "@/lib/data";
import { project, teamLine } from "@/lib/cbbProject";

export const dynamic = "force-dynamic";

const SEASON = 2026;
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball";

type SchedEvent = { date: string; opp: { id: number; name: string }; home: boolean; neutral: boolean; completed: boolean; us: number | null; them: number | null; detail: string | null };

async function loadSchedule(teamId: number): Promise<SchedEvent[]> {
  try {
    const res = await fetch(`${ESPN}/teams/${teamId}/schedule?season=${SEASON + 1}&seasontype=2`, { next: { revalidate: 1800 } });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      events?: {
        date: string;
        competitions?: {
          neutralSite?: boolean;
          status?: { type?: { completed?: boolean; shortDetail?: string } };
          competitors?: { id?: string; homeAway?: string; team?: { id?: string; displayName?: string }; score?: { value?: number } | string }[];
        }[];
      }[];
    };
    const out: SchedEvent[] = [];
    for (const e of j.events ?? []) {
      const c = e.competitions?.[0];
      if (!c?.competitors || c.competitors.length !== 2) continue;
      const me = c.competitors.find((x) => String(x.team?.id ?? x.id) === String(teamId));
      const them = c.competitors.find((x) => x !== me);
      if (!me || !them) continue;
      const sc = (x: typeof me): number | null => {
        const v = typeof x.score === "object" ? x.score?.value : Number(x.score);
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      out.push({
        date: e.date,
        opp: { id: Number(them.team?.id ?? them.id), name: them.team?.displayName ?? "TBD" },
        home: me.homeAway === "home",
        neutral: Boolean(c.neutralSite),
        completed: Boolean(c.status?.type?.completed),
        us: sc(me),
        them: sc(them),
        detail: c.status?.type?.shortDetail ?? null,
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

const n = (v: unknown, d = 1): string => (typeof v === "number" ? v.toFixed(d) : "—");
const sg = (v: unknown, d = 1): string => (typeof v === "number" ? `${v > 0 ? "+" : ""}${v.toFixed(d)}` : "—");
const tone = (v: unknown) => (typeof v === "number" ? (v > 0.05 ? "text-up" : v < -0.05 ? "text-down" : "text-foreground") : "text-muted");
const short = (c: string | null) => (c ?? "").replace(/ Conference$/, "");
const fmtHt = (h: unknown) => (typeof h === "number" ? `${Math.floor(h / 12)}'${Math.round(h % 12)}"` : "—");
const pc = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(0)}` : "—");

export default async function CbbTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const teamId = Number(id);
  if (!Number.isFinite(teamId)) notFound();

  const [ratings, roster, schedule] = await Promise.all([getCbbTeamRatings(teamId), getCbbPlayers({ season: SEASON, teamId, limit: 40 }), loadSchedule(teamId)]);
  const pre = ratings.find((r) => r.kind === "preseason" && r.season === SEASON);
  const fin = ratings.find((r) => r.kind === "final");
  if (!pre && !fin && roster.length === 0) notFound();
  const name = (pre ?? fin)?.team ?? "Team";
  const ps = pre?.stats ?? {};
  const us = teamLine(pre?.stats);

  const opps = await getCbbRatingsFor([...new Set(schedule.map((e) => e.opp.id))], SEASON, "preseason");
  const oppBy = new Map(opps.map((o) => [o.team_id, o]));
  const upcoming = schedule.filter((e) => !e.completed);
  const played = schedule.filter((e) => e.completed);
  const wins = played.filter((e) => e.us !== null && e.them !== null && e.us > e.them).length;

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle={name} sport="cbb" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface p-4">
          <CbbLogo teamId={teamId} size={56} />
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold text-foreground">{name}</div>
            <div className="text-xs text-muted">
              {short(pre?.conference ?? fin?.conference ?? null)}
              {ps.coach ? ` · Head coach ${String(ps.coach)}` : ""}
            </div>
            {Number(ps.incomplete) === 1 && (
              <div className="mt-1 text-[11px] text-warn">
                ESPN lists only {n(ps.roster_listed, 0)} players so far - incoming transfers and signees are not loaded, so this projection is rough until they are.
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted">Preseason rank</div>
              <div className="font-mono text-base font-semibold text-foreground">#{n(ps.rank, 0)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted">Net</div>
              <div className={`font-mono text-base font-semibold ${tone(ps.net)}`}>{sg(ps.net)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted">Off / Def</div>
              <div className="font-mono text-base font-semibold text-foreground">
                {n(ps.off)} / {n(ps.def)}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted">Last season</div>
              <div className="font-mono text-base font-semibold text-foreground">
                {fin ? `${n(fin.stats.wins, 0)}-${n(fin.stats.losses, 0)} · #${n(fin.stats.rank, 0)}` : "—"}
              </div>
            </div>
          </div>
        </div>

        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Roster and player ratings</h2>
          {roster.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-5 text-sm text-muted">No roster published yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-medium">Player</th>
                    <th className="px-2 py-2 font-medium">Cl</th>
                    <th className="px-2 py-2 font-medium">Ht</th>
                    <th className="px-3 py-2 text-right font-medium" title="Projected rating, points per 100 possessions vs an average player">Rating</th>
                    <th className="px-3 py-2 text-right font-medium">Off</th>
                    <th className="px-3 py-2 text-right font-medium" title="Lower is better">Def</th>
                    <th className="px-3 py-2 text-right font-medium" title="Projected minutes per game (a team plays 200 player-minutes: five players for 40)">Proj MPG</th>
                    <th className="border-l border-border px-3 py-2 text-right font-medium">MPG</th>
                    <th className="px-3 py-2 text-right font-medium">PPG</th>
                    <th className="px-3 py-2 text-right font-medium">RPG</th>
                    <th className="px-3 py-2 text-right font-medium">APG</th>
                    <th className="px-3 py-2 text-right font-medium">TS%</th>
                    <th className="px-3 py-2 text-right font-medium">3P%</th>
                    <th className="px-3 py-2 font-medium">From</th>
                  </tr>
                </thead>
                <tbody>
                  {roster
                    .slice()
                    .sort((a, b) => Number(b.stats.proj_floor ?? 0) - Number(a.stats.proj_floor ?? 0))
                    .map((r) => {
                      const s = r.stats;
                      const role = String(s.role ?? "");
                      return (
                        <tr key={r.player_id} className="border-b border-border last:border-0 odd:bg-surface/50">
                          <td className="px-3 py-1.5 whitespace-nowrap text-foreground">{r.name}</td>
                          <td className="px-2 py-1.5 text-muted">{(s.class as string) ?? ""}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-muted">{fmtHt(s.height)}</td>
                          <td className={`px-3 py-1.5 text-right font-mono font-semibold ${tone(s.proj_net)}`}>{sg(s.proj_net)}</td>
                          <td className={`px-3 py-1.5 text-right font-mono ${tone(s.last_off)}`}>{sg(s.last_off)}</td>
                          <td className={`px-3 py-1.5 text-right font-mono ${typeof s.last_def === "number" ? (s.last_def < -0.05 ? "text-up" : s.last_def > 0.05 ? "text-down" : "text-foreground") : "text-muted"}`}>{sg(s.last_def)}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.proj_mpg, 1)}</td>
                          <td className="border-l border-border px-3 py-1.5 text-right font-mono text-foreground">{n(s.mpg)}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.ppg)}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.rpg)}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-foreground">{n(s.apg)}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-foreground">{pc(s.ts_pct)}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-foreground">{pc(s.tp_pct)}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap text-muted">
                            {role === "transfer" ? String(s.prev_team ?? "") : role === "returner" ? "returning" : role}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted">
            Rating is each player&apos;s projected value for 2026-27 (points per 100 possessions vs an average player); Off/Def are last season&apos;s measured offence and
            defence; Proj MPG is his expected minutes a game (a team has 200 to hand out). Per-game numbers are last season&apos;s.{" "}
            <Link href="/cbb/players" className="text-accent hover:underline">
              All players ›
            </Link>
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Schedule{played.length > 0 ? ` · ${wins}-${played.length - wins}` : ""} <span className="font-normal normal-case text-muted">(projections from the preseason ratings)</span>
          </h2>
          {schedule.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-5 text-sm text-muted">ESPN has not published this team&apos;s schedule yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Opponent</th>
                    <th className="px-3 py-2 text-right font-medium">Opp rank</th>
                    <th className="px-3 py-2 text-right font-medium">Result</th>
                    <th className="border-l border-border px-3 py-2 text-right font-medium" title="Projected margin for this team (positive = favoured)">Proj. margin</th>
                    <th className="px-3 py-2 text-right font-medium">Proj. total</th>
                    <th className="px-3 py-2 text-right font-medium">Win %</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((e, i) => {
                    const opp = oppBy.get(e.opp.id);
                    const oppLine = teamLine(opp?.stats);
                    const proj = us && oppLine ? (e.home || e.neutral ? project(us, oppLine, e.neutral) : project(oppLine, us, false)) : null;
                    const myMargin = proj ? (e.home || e.neutral ? proj.spread : -proj.spread) : null;
                    const myWin = proj ? (e.home || e.neutral ? proj.homeWin : 1 - proj.homeWin) : null;
                    const won = e.completed && e.us !== null && e.them !== null ? e.us > e.them : null;
                    return (
                      <tr key={`${e.date}-${i}`} className="border-b border-border last:border-0 odd:bg-surface/50">
                        <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtDate(e.date)}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <Link href={`/cbb/teams/${e.opp.id}`} prefetch={false} className="flex items-center gap-1.5 text-foreground hover:underline">
                            <span className="w-4 text-muted">{e.neutral ? "vs" : e.home ? "vs" : "@"}</span>
                            <CbbLogo teamId={e.opp.id} size={16} />
                            {e.opp.name}
                            {e.neutral && <span className="text-[10px] text-muted">neutral</span>}
                          </Link>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted">{opp ? `#${n(opp.stats.rank, 0)}` : "—"}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${won === null ? "text-muted" : won ? "text-up" : "text-down"}`}>
                          {won === null ? (e.detail ?? "") : `${won ? "W" : "L"} ${e.us}-${e.them}`}
                        </td>
                        <td className={`border-l border-border px-3 py-1.5 text-right font-mono ${tone(myMargin)}`}>{sg(myMargin)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-foreground">{proj ? n(proj.total) : "—"}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-foreground">{myWin === null ? "—" : `${(myWin * 100).toFixed(0)}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {upcoming.length > 0 && (
            <p className="mt-2 text-[11px] text-muted">
              Projections use this team&apos;s and each opponent&apos;s preseason ratings - they will update as the season is played. They are a pricing reference, not a
              betting signal.
            </p>
          )}
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
