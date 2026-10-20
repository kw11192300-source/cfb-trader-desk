import type { NbaGameModel, NbaSnapshot } from "@/lib/data";
import { devig, evWithPush, fairOdds, impliedProb, lineProbs, MARGIN_SD, TOTAL_SD } from "@/lib/nbaProj";
import { nbaMatchupColors, nbaShort } from "@/lib/nbaTeams";

const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;
const odds = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const sgn = (n: number, d = 1) => (n > 0 ? `+${n.toFixed(d)}` : n.toFixed(d));

/** "56.1% (-128)": a probability with its fair no-vig American price. */
function PO({ p, d = 0 }: { p: number; d?: number }) {
  return (
    <>
      {pct(p, d)} <span className="font-normal text-muted">({fairOdds(p)})</span>
    </>
  );
}

/** A two-way split bar in the teams' colours. */
function Split({ label, pAway, pHome, away, home, colors, dim }: { label: string; pAway: number; pHome: number; away: string; home: string; colors: { away: string; home: string }; dim?: boolean }) {
  return (
    <div className={dim ? "opacity-80" : ""}>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-mono font-semibold text-foreground">
          <PO p={pAway} /> <span className="font-sans font-normal text-muted">{nbaShort(away)}</span>
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
        <span className="font-mono font-semibold text-foreground">
          <span className="font-sans font-normal text-muted">{nbaShort(home)}</span> <PO p={pHome} />
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-raised">
        <div className="h-full" style={{ width: `${pAway * 100}%`, background: colors.away }} title={`${away} ${pct(pAway)}`} />
        <div className="h-full" style={{ width: `${pHome * 100}%`, background: colors.home }} title={`${home} ${pct(pHome)}`} />
      </div>
    </div>
  );
}

/** The model's outcome curve with the market's line drawn through it: the shaded split is the chance each side of the line wins. */
function Bell({ title, mean, sd, thr, unit, leftName, rightName, pLeft, pRight, pPush, meanLabel, thrLabel }: { title: string; mean: number; sd: number; thr: number; unit: string; leftName: string; rightName: string; pLeft: number; pRight: number; pPush: number; meanLabel: string; thrLabel: string }) {
  const W = 340;
  const H = 128;
  const padX = 10;
  const top = 18;
  const base = H - 26;
  const lo = Math.min(mean, thr) - 3 * sd;
  const hi = Math.max(mean, thr) + 3 * sd;
  const x = (v: number) => padX + ((v - lo) / (hi - lo)) * (W - padX * 2);
  const pdf = (v: number) => Math.exp(-0.5 * ((v - mean) / sd) ** 2);
  const steps = 90;
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const v = lo + ((hi - lo) * i) / steps;
    pts.push([x(v), base - pdf(v) * (base - top)]);
  }
  const xt = x(thr);
  const area = (from: number, to: number) => {
    const seg = pts.filter(([px]) => px >= from && px <= to);
    if (seg.length < 2) return "";
    return `M${seg[0][0].toFixed(1)},${base} ${seg.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join(" ")} L${seg[seg.length - 1][0].toFixed(1)},${base} Z`;
  };
  const curve = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const xm = x(mean);
  return (
    <div className="rounded-lg border border-border bg-surface-raised/40 px-3 py-3">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-[10px] text-muted">{unit}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <path d={area(padX, xt)} fill="var(--muted)" opacity="0.25" />
        <path d={area(xt, W - padX)} fill="var(--accent)" opacity="0.4" />
        <path d={curve} fill="none" stroke="currentColor" strokeWidth="1.6" className="text-foreground" />
        <line x1={xt} x2={xt} y1={top - 6} y2={base} stroke="var(--foreground)" strokeDasharray="4 3" strokeWidth="1.2" />
        <text x={xt} y={top - 8} textAnchor={xt > W / 2 ? "end" : "start"} dx={xt > W / 2 ? -3 : 3} fontSize="10" fill="var(--foreground)">
          market {thrLabel}
        </text>
        <line x1={xm} x2={xm} y1={top + 2} y2={base} stroke="var(--accent)" strokeWidth="2" />
        <text x={xm} y={base + 13} textAnchor="middle" fontSize="10" fill="var(--accent)">
          model {meanLabel}
        </text>
        <line x1={padX} x2={W - padX} y1={base} y2={base} stroke="var(--border)" />
      </svg>
      <div className="mt-1 flex items-baseline justify-between text-[11px]">
        <span className="font-mono text-foreground">
          <span className="font-sans text-muted">{leftName}</span> <PO p={pLeft} />
        </span>
        {pPush > 0.004 && <span className="text-[10px] text-muted">push {pct(pPush, 0)}</span>}
        <span className="font-mono text-foreground">
          <PO p={pRight} /> <span className="font-sans text-muted">{rightName}</span>
        </span>
      </div>
    </div>
  );
}

type Row = { market: string; side: string; price: number | null; p: number; pWin: number; pLose: number };

/** Model vs the posted market for spread, total and moneyline, in the style of the NHL pages: win-probability bars, the model's outcome
 * curve against each line, and a table of every priced side with break-even, model chance, fair price, edge and EV. */
export default function NbaModelVsOdds({ away, home, model, cur }: { away: string; home: string; model: NbaGameModel; cur: NbaSnapshot | null }) {
  const colors = nbaMatchupColors(away, home);
  const homeShort = nbaShort(home);
  const awayShort = nbaShort(away);
  const mkt = devig(cur?.ml_home, cur?.ml_away); // market home win chance, vig removed
  const rows: Row[] = [];
  if (cur?.ml_away != null) rows.push({ market: "Moneyline", side: awayShort, price: cur.ml_away, p: 1 - model.p_home, pWin: 1 - model.p_home, pLose: model.p_home });
  if (cur?.ml_home != null) rows.push({ market: "Moneyline", side: homeShort, price: cur.ml_home, p: model.p_home, pWin: model.p_home, pLose: 1 - model.p_home });

  const L = cur?.spread_home_line ?? null; // the home team's own number
  const sp = L !== null ? lineProbs(model.margin, MARGIN_SD, -L) : null; // above = home margin beats -L = home covers
  if (L !== null && sp) {
    if (cur?.spread_away_odds != null) rows.push({ market: "Spread", side: `${awayShort} ${sgn(-L)}`, price: cur.spread_away_odds, p: sp.below / Math.max(sp.below + sp.above, 1e-9), pWin: sp.below, pLose: sp.above });
    if (cur?.spread_home_odds != null) rows.push({ market: "Spread", side: `${homeShort} ${sgn(L)}`, price: cur.spread_home_odds, p: sp.above / Math.max(sp.below + sp.above, 1e-9), pWin: sp.above, pLose: sp.below });
  }
  const T = cur?.total_line ?? null;
  const tp = T !== null ? lineProbs(model.total, TOTAL_SD, T) : null;
  if (T !== null && tp) {
    if (cur?.over_odds != null) rows.push({ market: "Total", side: `Over ${T}`, price: cur.over_odds, p: tp.above / Math.max(tp.below + tp.above, 1e-9), pWin: tp.above, pLose: tp.below });
    if (cur?.under_odds != null) rows.push({ market: "Total", side: `Under ${T}`, price: cur.under_odds, p: tp.below / Math.max(tp.below + tp.above, 1e-9), pWin: tp.below, pLose: tp.above });
  }
  const evOf = (r: Row) => (r.price === null ? null : evWithPush(r.pWin, r.pLose, r.price));
  const best = rows.reduce<{ r: Row; e: number } | null>((b, r) => {
    const e = evOf(r);
    return e !== null && (b === null || e > b.e) ? { r, e } : b;
  }, null);

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">Model vs the odds</h2>
        <span className="text-[11px] text-muted">win probability · spread · total · every priced side</span>
      </div>

      <p className="mb-3 rounded border border-warn/40 bg-warn/5 px-3 py-2 text-[11px] leading-relaxed text-muted">
        <span className="font-semibold text-warn">Baseline, not a betting signal.</span> Tested on past seasons the player-up model alone does not beat the market&apos;s closing line; where it differs, the usual reason is injury
        news the line has not absorbed yet. Curves assume results scatter around the model&apos;s number by {MARGIN_SD} points for margin and {TOTAL_SD} for the total. Use this as a fair-price reference.
      </p>

      <div className="space-y-3">
        <Split label="model" pAway={1 - model.p_home} pHome={model.p_home} away={away} home={home} colors={colors} />
        {mkt !== null && <Split label="market (no vig)" pAway={1 - mkt} pHome={mkt} away={away} home={home} colors={colors} dim />}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {L !== null && sp && (
          <Bell
            title="Spread - where the home margin lands"
            mean={model.margin}
            sd={MARGIN_SD}
            thr={-L}
            unit={`${homeShort} margin`}
            leftName={`${awayShort} ${sgn(-L)}`}
            rightName={`${homeShort} ${sgn(L)}`}
            pLeft={sp.below / Math.max(sp.below + sp.above, 1e-9)}
            pRight={sp.above / Math.max(sp.below + sp.above, 1e-9)}
            pPush={sp.push}
            meanLabel={`${homeShort} ${sgn(-model.margin)}`}
            thrLabel={`${homeShort} ${sgn(L)}`}
          />
        )}
        {T !== null && tp && (
          <Bell
            title="Total - where the points land"
            mean={model.total}
            sd={TOTAL_SD}
            thr={T}
            unit="combined points"
            leftName="Under"
            rightName="Over"
            pLeft={tp.below / Math.max(tp.below + tp.above, 1e-9)}
            pRight={tp.above / Math.max(tp.below + tp.above, 1e-9)}
            pPush={tp.push}
            meanLabel={model.total.toFixed(1)}
            thrLabel={`${T}`}
          />
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <p className="mb-2 text-xs text-muted">
            {best && best.e > 0 ? (
              <>
                Largest gap: <span className="text-foreground">{best.r.market} {best.r.side}</span> - model {pct(best.r.p)} vs the {pct(impliedProb(best.r.price as number))} that {odds(best.r.price as number)} needs, worth{" "}
                <span className="font-mono text-accent">
                  {best.e >= 0 ? "+" : ""}
                  {(best.e * 100).toFixed(1)}% EV
                </span>{" "}
                if the model is right.
              </>
            ) : (
              <>No side beats the posted price by the model&apos;s numbers - it agrees with the market, or differs by less than the vig.</>
            )}
          </p>
          <table className="w-full min-w-[560px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="px-3 py-1.5 text-left font-medium">Market</th>
                <th className="px-3 py-1.5 text-left font-medium">Side</th>
                <th className="px-3 py-1.5 text-right font-medium">Book price</th>
                <th className="px-3 py-1.5 text-right font-medium" title="The win probability the posted price needs to break even (vig included)">Break-even</th>
                <th className="px-3 py-1.5 text-right font-medium">Model</th>
                <th className="px-3 py-1.5 text-right font-medium" title="The model's fair (no-vig) price">Model price</th>
                <th className="px-3 py-1.5 text-right font-medium" title="Model probability minus break-even">Edge (pts)</th>
                <th className="px-3 py-1.5 text-right font-medium" title="Expected profit per unit staked at the posted price if the model is right">EV</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const e = evOf(r);
                const be = r.price !== null ? impliedProb(r.price) : null;
                const live = e !== null && e > 0;
                const newMarket = i === 0 || rows[i - 1].market !== r.market;
                return (
                  <tr key={`${r.market}-${r.side}`} className={`border-b border-border last:border-0 ${live ? "bg-accent/10" : ""} ${newMarket && i > 0 ? "border-t border-t-border" : ""}`}>
                    <td className="px-3 py-1.5 text-muted">{newMarket ? r.market : ""}</td>
                    <td className="px-3 py-1.5 text-foreground">
                      {r.side}
                      {e !== null && e >= 0.03 && <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-background">GAP</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-up">{r.price !== null ? odds(r.price) : "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{be !== null ? pct(be) : "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{pct(r.p)}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-foreground">{fairOdds(r.p)}</td>
                    <td className={`px-3 py-1.5 text-right font-mono ${be !== null && r.p - be > 0 ? "text-up" : "text-down"}`}>{be !== null ? `${r.p - be > 0 ? "+" : ""}${((r.p - be) * 100).toFixed(1)}` : "—"}</td>
                    <td className={`px-3 py-1.5 text-right font-mono ${live ? "text-accent" : "text-muted"}`}>{e !== null ? `${e >= 0 ? "+" : ""}${(e * 100).toFixed(1)}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

