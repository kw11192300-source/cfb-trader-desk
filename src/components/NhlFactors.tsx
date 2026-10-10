import { importanceLabel, injuryImpact, normName, restInfo, type Caution, type Injury, type NhlContext } from "@/lib/nhlContext";
import type { NhlLineupAdjustment } from "@/lib/types";
import { espnCode } from "@/lib/nhlTeams";
import NhlTeamLogo from "./NhlTeamLogo";

const SOURCE_LABEL: Record<string, string> = {
  espn_confirmed: "Confirmed (ESPN)",
  espn_expected: "Expected (ESPN)",
  locked: "Locked by you",
  usage: "Estimated from recent starts",
};

const STATUS_STYLE: Record<Injury["status"], string> = {
  Out: "bg-down/15 text-down",
  "Day-To-Day": "bg-warn/15 text-warn",
  IR: "bg-surface-raised text-muted",
  Suspension: "bg-surface-raised text-muted",
};

const STATUS_LABEL: Record<Injury["status"], string> = { Out: "Out", "Day-To-Day": "Day-to-day", IR: "IR", Suspension: "Suspended" };

type Assumptions = {
  lineup?: NhlLineupAdjustment;
  goalies: { home: { name: string; weight: number }[]; away: { name: string; weight: number }[] };
  confirmed?: { home: boolean; away: boolean };
  sources?: { home: string; away: string };
};

function TeamColumn({ team, side, startIso, assumptions, ctx }: { team: string; side: "home" | "away"; startIso: string; assumptions: Assumptions | null; ctx: NhlContext }) {
  const rest = restInfo(ctx, team, startIso);
  const injuries = (ctx.injuries[espnCode(team) ?? ""] ?? []).slice().sort((a, b) => ["Out", "Day-To-Day", "Suspension", "IR"].indexOf(a.status) - ["Out", "Day-To-Day", "Suspension", "IR"].indexOf(b.status));
  const goalies = assumptions?.goalies[side] ?? [];
  const gp = ctx.gp[team];
  return (
    <div className="min-w-0 rounded-md bg-surface-raised p-3">
      <div className="mb-2 flex items-center gap-2 text-sm text-foreground">
        <NhlTeamLogo team={team} size={20} />
        {team}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Goalie</dt>
        <dd className="text-foreground">
          {goalies.length === 0 ? "—" : goalies.map((g) => `${g.name}${goalies.length > 1 ? ` ${Math.round(g.weight * 100)}%` : ""}`).join(" / ")}
          {assumptions?.sources && <span className="ml-2 text-muted">{SOURCE_LABEL[assumptions.sources[side]] ?? assumptions.sources[side]}</span>}
        </dd>
        <dt className="text-muted">Rest</dt>
        <dd className="text-foreground">
          {rest.daysRest === null ? "—" : rest.backToBack ? <span className="font-semibold text-warn">back-to-back</span> : `${rest.daysRest} day${rest.daysRest === 1 ? "" : "s"}`}
          <span className="ml-2 text-muted">{rest.gamesLast7} game{rest.gamesLast7 === 1 ? "" : "s"} in the last 7 days</span>
        </dd>
        <dt className="text-muted">Played</dt>
        <dd className="text-foreground">{typeof gp === "number" ? `${gp} games this season` : "—"}</dd>
      </dl>
      <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Injury report</div>
      {injuries.length === 0 ? (
        <div className="mt-1 text-xs text-muted">Nothing listed.</div>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {injuries.map((i) => {
            const r = i.position === "G" ? undefined : ctx.ratings[normName(i.name)];
            const key = r !== undefined && r.pct >= 0.75;
            return (
            <li key={`${i.name}-${i.status}`} className="flex items-start gap-2 text-xs" title={i.comment ?? undefined}>
              <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[i.status]}`}>{STATUS_LABEL[i.status]}</span>
              <span className="min-w-0 text-foreground">
                {i.name}
                {i.position && <span className="ml-1 text-muted">{i.position}</span>}
                {(i.type || i.returnDate) && (
                  <span className="ml-2 text-muted">
                    {i.type}
                    {i.returnDate ? `${i.type ? " · " : ""}back ~${new Date(i.returnDate).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}
                  </span>
                )}
                {i.position !== "G" && Object.keys(ctx.ratings).length > 0 && (
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${key ? "bg-warn/15 font-semibold text-warn" : "bg-surface text-muted"}`} title={r ? `5v5 impact ${r.net >= 0 ? "+" : ""}${r.net.toFixed(2)} xG/60 over ${r.toiPg.toFixed(0)} min a game` : undefined}>
                    {r ? `${importanceLabel(r)} · #${r.rank}/${r.n}` : importanceLabel(r)}
                  </span>
                )}
              </span>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const nickOf = (t: string) => t.split(" ").slice(-1)[0];

/** The lineup adjustment that IS in the model: each side's change in scoring (own offence + the opponent's defence) from who is
 * expected to dress, with the biggest arrivals and absences by name. */
function LineupLine({ home, away, lineup }: { home: string; away: string; lineup: NhlLineupAdjustment }) {
  const fmt = (n: number, d = 2) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
  const side = (team: string, key: "home" | "away") => {
    const s = lineup[key];
    const names = [
      ...s.arrivals.filter((a) => Math.abs(a.value) >= 0.02).map((a) => `${a.name} in`),
      ...s.missing.filter((m) => Math.abs(m.value) >= 0.02).map((m) => `${m.name} out`),
    ];
    return (
      <div className="min-w-0">
        <span className="text-foreground">{nickOf(team)}</span>{" "}
        <span className="font-mono font-semibold text-foreground">{fmt(s.net_xg)}</span>
        <span className="text-muted"> xG/game vs. the lineup its rating was built on</span>
        {names.length > 0 && <div className="text-[11px] text-muted">{names.slice(0, 4).join(" · ")}</div>}
      </div>
    );
  };
  return (
    <div className="mb-3 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold text-foreground">Lineup adjustment</span>
        <span className="text-muted">included in the numbers above - the current roster minus injuries, vs. the lineup each team&apos;s rating was built from</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {side(away, "away")}
        {side(home, "home")}
      </div>
      <div className="mt-1 text-[11px] text-muted">
        Scoring shift applied to the simulation (own offense + opponent&apos;s defense): {nickOf(away)} {fmt(lineup.applied_xg.away)}, {nickOf(home)}{" "}
        {fmt(lineup.applied_xg.home)} xG per game. Half the strength the backtest supported, capped, even strength only.
      </div>
    </div>
  );
}

/** A rough number for what the injuries are worth, so a gap to the market has something to be compared against. */
function InjuryImpactLine({ home, away, ctx }: { home: string; away: string; ctx: NhlContext }) {
  const h = injuryImpact(ctx, home);
  const a = injuryImpact(ctx, away);
  if (h.players.length === 0 && a.players.length === 0) return null;
  const net = h.winPts - a.winPts; // + helps the home team
  const fmt = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
  return (
    <div className="mb-3 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs">
      <span className="text-muted">Rough injury effect on win probability (not in the model): </span>
      <span className="font-mono text-foreground">
        {nickOf(away)} {fmt(a.winPts)} pts · {nickOf(home)} {fmt(h.winPts)} pts
      </span>
      <span className="text-muted"> → net </span>
      <span className={`font-mono font-semibold ${Math.abs(net) >= 1 ? "text-warn" : "text-foreground"}`}>
        {fmt(net)} pts for {nickOf(home)}
      </span>
      <div className="mt-1 text-[11px] text-muted">
        Sum of each injured skater&apos;s 5v5 impact per game (Out counted fully, day-to-day half), scaled by what the lineup backtest supports.
        Even strength only and a rough conversion - treat as a size-of-the-thing, not a price.
      </div>
    </div>
  );
}

/** What the model doesn't know about this game, and the reasons (if any) to treat its numbers with caution. */
export default function NhlFactors({
  home,
  away,
  startIso,
  assumptions,
  ctx,
  cautions,
}: {
  home: string;
  away: string;
  startIso: string;
  assumptions: Assumptions | null;
  ctx: NhlContext;
  cautions: Caution[];
}) {
  return (
    <div>
      {cautions.length > 0 ? (
        <div className="mb-3 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
          <div className="mb-1 font-semibold text-warn">Treat with caution</div>
          <ul className="list-disc pl-5 text-muted">
            {cautions.map((c) => (
              <li key={c.short}>{c.long}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mb-3 text-xs text-muted">Nothing we know of that the model is missing for this game - goalies confirmed, no back-to-back, no injury flags.</p>
      )}
      {assumptions?.lineup ? (
        <LineupLine home={home} away={away} lineup={assumptions.lineup} />
      ) : (
        Object.keys(ctx.ratings).length > 0 && <InjuryImpactLine home={home} away={away} ctx={ctx} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <TeamColumn team={away} side="away" startIso={startIso} assumptions={assumptions} ctx={ctx} />
        <TeamColumn team={home} side="home" startIso={startIso} assumptions={assumptions} ctx={ctx} />
      </div>
      <p className="mt-2 text-[11px] text-muted">
        The goalie is the one thing here the model does use. Injuries, rest and travel are context only: it assumes both teams dress their normal lineup, so a
        missing top player or a tired backup shows up as a gap against the market that isn&apos;t really an edge. Injury data is ESPN&apos;s and can lag.
      </p>
    </div>
  );
}
