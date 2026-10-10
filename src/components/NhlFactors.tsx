import { restInfo, type Caution, type Injury, type NhlContext } from "@/lib/nhlContext";
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
          {injuries.map((i) => (
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
              </span>
            </li>
          ))}
        </ul>
      )}
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
