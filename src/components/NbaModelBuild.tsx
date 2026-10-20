import Image from "next/image";
import type { NbaGameModel, NbaPlayerProjection } from "@/lib/data";
import type { NbaPlayerRating } from "@/lib/types";
import { nbaLogo, nbaShort } from "@/lib/nbaTeams";

const nameKey = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
const sg = (n: number, d = 1) => (n > 0 ? `+${n.toFixed(d)}` : n.toFixed(d));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One team's lineup math: each rotation player's expected minutes and rating, and what he adds to the team's offence and defence.
 * Adds = minutes / 48 x rating, so the column sums to the team's strength relative to an average team (five average players = 0). */
function TeamBuild({ team, players, ratings }: { team: string; players: NbaPlayerProjection[]; ratings: Map<string, NbaPlayerRating> }) {
  const logo = nbaLogo(team);
  const rows = players
    .filter((p) => (p.exp_min ?? 0) >= 6)
    .sort((a, b) => (b.exp_min ?? 0) - (a.exp_min ?? 0))
    .map((p) => {
      const r = ratings.get(nameKey(p.name));
      const off = r ? num(r.stats.off) : null;
      const def = r ? num(r.stats.def) : null; // points allowed LESS than average (positive = good)
      const net = r?.net ?? null;
      const w = (p.exp_min ?? 0) / 48;
      return { p, off, def, net, addOff: off !== null ? w * off : 0, addDef: def !== null ? w * def : 0, addNet: net !== null ? w * net : 0, poss: r ? num(r.stats.poss) : null };
    });
  const tot = rows.reduce((s, r) => ({ off: s.off + r.addOff, def: s.def + r.addDef, net: s.net + r.addNet, min: s.min + (r.p.exp_min ?? 0) }), { off: 0, def: 0, net: 0, min: 0 });
  const tone = (v: number) => (v > 0.05 ? "text-up" : v < -0.05 ? "text-down" : "text-muted");
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        {logo ? <Image src={logo} alt="" width={20} height={20} className="object-contain" style={{ width: 20, height: 20 }} unoptimized /> : null}
        <span className="text-sm font-semibold text-foreground">{team}</span>
        <span className="text-[11px] text-muted">player ratings x minutes</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted">
              <th className="px-4 py-1.5 text-left font-medium">Player</th>
              <th className="px-2 py-1.5 text-right font-medium">Min</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Points per 100 possessions he adds on offence over an average player">Off</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Points per 100 possessions he saves on defence (positive = good)">Def</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Off + Def: his lineup rating">Net</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Minutes / 48 x Net: what he adds to the team's rating per 100 possessions">Adds</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map(({ p, off, def, net, addNet }, i) => (
              <tr key={p.player_id} className={`border-t border-border/50 ${i % 2 ? "bg-surface-raised/30" : ""}`}>
                <td className="whitespace-nowrap px-4 py-1.5 font-sans font-medium text-foreground">
                  {p.name}
                  {net === null && <span className="ml-1.5 text-[10px] font-normal text-muted">unrated</span>}
                </td>
                <td className="px-2 py-1.5 text-right text-foreground">{(p.exp_min ?? 0).toFixed(0)}</td>
                <td className={`px-2 py-1.5 text-right ${off !== null ? tone(off) : "text-muted"}`}>{off !== null ? sg(off) : "—"}</td>
                <td className={`px-2 py-1.5 text-right ${def !== null ? tone(def) : "text-muted"}`}>{def !== null ? sg(def) : "—"}</td>
                <td className={`px-2 py-1.5 text-right font-semibold ${net !== null ? tone(net) : "text-muted"}`}>{net !== null ? sg(net) : "—"}</td>
                <td className={`px-2 py-1.5 text-right ${tone(addNet)}`}>{sg(addNet, 2)}</td>
              </tr>
            ))}
            <tr className="border-t border-border bg-surface-raised/60 font-semibold">
              <td className="px-4 py-1.5 font-sans text-[11px] uppercase tracking-wide text-muted">Team vs average</td>
              <td className="px-2 py-1.5 text-right text-foreground">{tot.min.toFixed(0)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(tot.off)}`}>{sg(tot.off, 1)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(tot.def)}`}>{sg(tot.def, 1)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(tot.net)}`}>{sg(tot.net, 1)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(tot.net)}`}>{sg(tot.net, 2)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** How the model gets from players to the game numbers: lineup ratings x projected minutes -> each team's offence and defence ->
 * points per 100 possessions in this matchup -> x pace -> margin and total. */
export default function NbaModelBuild({ away, home, model, players, rated }: { away: string; home: string; model: NbaGameModel; players: NbaPlayerProjection[]; rated: NbaPlayerRating[] }) {
  const ratings = new Map(rated.map((r) => [nameKey(r.name), r]));
  const h = nbaShort(home);
  const a = nbaShort(away);
  // per-100 points each side scores in this matchup: league average + own offence + opponent's defence (points allowed vs average)
  const homePpp = model.L + model.home_off + model.away_de;
  const awayPpp = model.L + model.away_off + model.home_de;
  const rowCls = "flex items-baseline justify-between gap-4 border-t border-border/50 py-1.5 first:border-t-0";
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4">
      <h2 className="text-sm font-semibold text-foreground">How the model builds this game</h2>
      <p className="mb-3 mt-1 text-[11px] leading-relaxed text-muted">
        Each player has a lineup rating from play-by-play (points per 100 possessions he adds over an average player, split into offence and defence - an EPM-style rating built only from public data). A team&apos;s strength is its
        players&apos; ratings weighted by the minutes they are expected to play (Adds = minutes / 48 x rating), averaged over who is in or out on the injury report.
      </p>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TeamBuild team={away} players={players.filter((p) => p.side === "away")} ratings={ratings} />
        <TeamBuild team={home} players={players.filter((p) => p.side === "home")} ratings={ratings} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-1 text-xs md:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Points per 100 possessions in this matchup</div>
          <div className={rowCls}>
            <span className="text-muted">League average team</span>
            <span className="font-mono text-foreground">{model.L.toFixed(1)}</span>
          </div>
          <div className={rowCls}>
            <span className="text-foreground">{h} score</span>
            <span className="font-mono text-foreground">
              {model.L.toFixed(1)} {sg(model.home_off)} offence {sg(model.away_de)} vs {a} defence = <b>{homePpp.toFixed(1)}</b>
            </span>
          </div>
          <div className={rowCls}>
            <span className="text-foreground">{a} score</span>
            <span className="font-mono text-foreground">
              {model.L.toFixed(1)} {sg(model.away_off)} offence {sg(model.home_de)} vs {h} defence = <b>{awayPpp.toFixed(1)}</b>
            </span>
          </div>
          <div className="mt-1 text-[10px] text-muted">Defence figures are points allowed relative to average, so a negative number is a good defence.</div>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">To the game numbers</div>
          <div className={rowCls}>
            <span className="text-muted">Pace (possessions per team)</span>
            <span className="font-mono text-foreground">{model.pace.toFixed(1)}</span>
          </div>
          <div className={rowCls}>
            <span className="text-foreground">Margin</span>
            <span className="font-mono text-foreground">
              ({homePpp.toFixed(1)} − {awayPpp.toFixed(1)}) x {model.pace.toFixed(0)}/100 {sg(model.hca)} home court = <b>{h} {sg(model.margin)}</b>
            </span>
          </div>
          <div className={rowCls}>
            <span className="text-foreground">Total</span>
            <span className="font-mono text-foreground">
              ({homePpp.toFixed(1)} + {awayPpp.toFixed(1)}) x {model.pace.toFixed(0)}/100{model.level_shift !== undefined ? ` ${sg(model.level_shift)} scoring-level match` : ""} = <b>{model.total.toFixed(1)}</b>
            </span>
          </div>
          {model.pts && (
            <div className={rowCls}>
              <span className="text-foreground">Team points</span>
              <span className="font-mono text-foreground">
                {a} {model.pts.away.toFixed(1)} · {h} {model.pts.home.toFixed(1)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
