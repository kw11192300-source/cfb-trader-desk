import { fmtUnits } from "@/lib/betBreakdown";
import type { GradedBet } from "@/lib/data";

/** Cumulative units won/lost over time, graded bets only - shared across
 * every sport's Bets page (CFB's Risk tab, NFL/NHL's own Bets page, since
 * neither has a full Risk dashboard yet). Pending bets don't move the
 * line - only resolved profit/loss does. */
function buildPnlPoints(bets: GradedBet[]): { date: string; cumulative: number }[] {
  return [...bets]
    .filter((g) => g.status !== "pending" && g.game)
    .sort((a, b) => new Date(a.game!.start_date).getTime() - new Date(b.game!.start_date).getTime())
    .reduce<{ date: string; cumulative: number }[]>((acc, g) => {
      const prev = acc.length > 0 ? acc[acc.length - 1].cumulative : 0;
      const date = new Date(g.game!.start_date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      acc.push({ date, cumulative: prev + (g.profit ?? 0) });
      return acc;
    }, []);
}

export default function PnlChart({ bets }: { bets: GradedBet[] }) {
  const points = buildPnlPoints(bets);
  if (points.length < 2) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-xs text-muted">
        Not enough graded bets yet for a P&amp;L chart.
      </div>
    );
  }
  const W = 780;
  const H = 240;
  const padL = 44;
  const padR = 60;
  const padT = 16;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const values = points.map((p) => p.cumulative);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const range = maxV - minV || 1;
  const x = (i: number) => padL + (points.length > 1 ? (i / (points.length - 1)) * plotW : 0);
  const y = (v: number) => padT + plotH - ((v - minV) / range) * plotH;
  const zeroY = y(0);
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(p.cumulative)}`).join(" ");
  const last = points[points.length - 1].cumulative;
  const color = last >= 0 ? "var(--up)" : "var(--down)";

  // Max drawdown: the largest peak-to-trough drop anywhere in the series.
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, v - peak);
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">P&amp;L over time (graded bets)</h3>
        <span className="font-mono text-xs text-muted">
          max drawdown <span className="text-down">{maxDD.toFixed(2)}u</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 260 }}>
        <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeWidth={1} strokeDasharray="4 3" />
        <text x={padL - 6} y={zeroY + 3} fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)" textAnchor="end">
          0
        </text>
        <path d={pathD} fill="none" stroke={color} strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.cumulative)} r={2.5} fill={color} />
        ))}
        <text x={padL} y={H - 6} fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">
          {points[0].date}
        </text>
        <text x={W - padR} y={H - 6} fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)" textAnchor="end">
          {points[points.length - 1].date}
        </text>
        <text x={x(points.length - 1) + 6} y={y(last) + 4} fontSize={11} fill={color} fontFamily="var(--font-mono)" fontWeight={600}>
          {fmtUnits(last)}
        </text>
      </svg>
    </div>
  );
}
