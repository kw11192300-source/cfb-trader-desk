import { type ExGame, label, pct } from "@/lib/syndicates";

export type Series = { id: string; name: string; color: string; pts: [number, number][]; step?: boolean };
export type Dot = { x: number; y: number; color: string; r?: number; tip?: string };

const nice = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** A plain SVG line chart: several series on shared numeric axes, optional dots, an optional zero line and vertical marker. */
export function LineChart({
  series, dots = [], height = 220, zero = false, xLabel, yLabel, xFmt, yFmt, vline,
}: {
  series: Series[]; dots?: Dot[]; height?: number; zero?: boolean; xLabel?: string; yLabel?: string; xFmt?: (x: number) => string; yFmt?: (y: number) => string; vline?: number;
}) {
  const all = [...series.flatMap((s) => s.pts), ...dots.map((d) => [d.x, d.y] as [number, number])];
  if (all.length < 2) return <p className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-xs text-muted">Nothing to chart yet.</p>;
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
  if (zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
  const pad = (y1 - y0) * 0.08 || 1;
  y0 -= pad; y1 += pad;
  const W = 900, H = height, L = 52, R = 12, T = 8, B = 22;
  const x = (v: number) => L + ((v - x0) / Math.max(1e-9, x1 - x0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - y0) / Math.max(1e-9, y1 - y0)) * (H - T - B);
  const yf = yFmt ?? nice, xf = xFmt ?? ((v: number) => String(Math.round(v)));
  const path = (s: Series) => {
    if (!s.step) return s.pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
    return s.pts.map((p, i) => (i === 0 ? `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}` : `${x(p[0]).toFixed(1)},${y(s.pts[i - 1][1]).toFixed(1)} ${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`)).join(" ");
  };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-border bg-surface">
        {[0, 0.5, 1].map((f) => {
          const v = y0 + (y1 - y0) * f;
          return (
            <g key={f}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-border" strokeWidth="0.5" />
              <text x={L - 6} y={y(v) + 3} textAnchor="end" className="fill-muted" fontSize="10">{yf(v)}</text>
            </g>
          );
        })}
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={L + (W - L - R) * f} y={H - 6} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="fill-muted" fontSize="10">{xf(x0 + (x1 - x0) * f)}</text>
        ))}
        {zero && y0 < 0 && y1 > 0 && <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-muted" strokeDasharray="3 3" />}
        {vline !== undefined && vline >= x0 && vline <= x1 && <line x1={x(vline)} x2={x(vline)} y1={T} y2={H - B} stroke="currentColor" className="text-accent" strokeDasharray="2 3" />}
        {series.map((s) => (
          <polyline key={s.id} fill="none" stroke={s.color} strokeWidth="1.6" points={path(s)}>
            <title>{s.name}</title>
          </polyline>
        ))}
        {dots.map((d, i) => (
          <circle key={i} cx={x(d.x)} cy={y(d.y)} r={d.r ?? 2.5} fill={d.color} fillOpacity="0.75">
            {d.tip && <title>{d.tip}</title>}
          </circle>
        ))}
        {(xLabel || yLabel) && (
          <text x={W - R} y={T + 8} textAnchor="end" className="fill-muted" fontSize="10">{[yLabel, xLabel].filter(Boolean).join(" vs ")}</text>
        )}
      </svg>
      {series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          {series.map((s) => (
            <span key={s.id}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Bid and ask depth by line: bars for the size on each side, the fair price in the middle, a marker where the last trade was. */
export function LadderDepth({ g }: { g: ExGame }) {
  const book = g.book ?? [];
  const maxSz = Math.max(1, ...book.flatMap((r) => [r[7] ?? 0, r[8] ?? 0]));
  const kinds = [["ml", "Moneyline"], ["spread", "Spread"], ["total", "Total"]] as const;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {kinds.map(([k, title]) => {
        const rows = book.filter((r) => r[0] === k).sort((a, b) => a[1] - b[1]);
        if (!rows.length) return null;
        return (
          <table key={k} className="w-full text-[11px]">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-0.5 font-medium">{title}</th>
                <th className="py-0.5 text-right font-medium">Bid</th>
                <th className="w-24 py-0.5 text-center font-medium">Depth</th>
                <th className="py-0.5 font-medium">Ask</th>
                <th className="py-0.5 text-right font-medium">Fair</th>
                <th className="py-0.5 text-right font-medium">Last</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r) => (
                <tr key={`${r[0]}${r[1]}`} className="border-t border-border">
                  <td className="py-0.5 font-sans text-foreground">{label({ kind: r[0], line: r[1] }, g)}</td>
                  <td className="py-0.5 text-right">{pct(r[3])}</td>
                  <td className="py-0.5">
                    <div className="flex h-2.5 items-center">
                      <div className="flex w-1/2 justify-end"><div className="h-2 rounded-l bg-up/70" style={{ width: `${((r[7] ?? 0) / maxSz) * 100}%` }} /></div>
                      <div className="flex w-1/2"><div className="h-2 rounded-r bg-down/70" style={{ width: `${((r[8] ?? 0) / maxSz) * 100}%` }} /></div>
                    </div>
                  </td>
                  <td className="py-0.5">{pct(r[4])}</td>
                  <td className="py-0.5 text-right text-muted">{pct(r[2])}</td>
                  <td className="py-0.5 text-right text-accent">{pct(r[5])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}
