import LocalDateTime from "@/components/LocalDateTime";
import { type ExGame, label, pct } from "@/lib/syndicates";

export type Series = { id: string; name: string; color: string; pts: [number, number][]; step?: boolean };
export type Dot = { x: number; y: number; color: string; r?: number; tip?: string };

const nice = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** A plain SVG line chart: several series on shared numeric axes, optional dots, an optional zero line and vertical marker. */
export function LineChart({
  series, dots = [], height = 220, zero = false, xLabel, yLabel, xFmt, xTime, yFmt, vline, legend = true,
}: {
  series: Series[]; dots?: Dot[]; height?: number; zero?: boolean; xLabel?: string; yLabel?: string; xFmt?: (x: number) => string; xTime?: Intl.DateTimeFormatOptions; yFmt?: (y: number) => string; vline?: number; legend?: boolean;
}) {
  const all = [...series.flatMap((s) => s.pts), ...dots.map((d) => [d.x, d.y] as [number, number])];
  if (all.length < 2) return <p className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-xs text-muted">Nothing to chart yet.</p>;
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
  if (zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
  const pad = (y1 - y0) * 0.08 || 1;
  y0 -= pad; y1 += pad;
  const W = 900, H = height, L = 56, R = 14, T = 10, B = 26;
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
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const v = y0 + (y1 - y0) * f;
          return (
            <g key={f}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-border" strokeWidth="0.6" />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-muted" fontSize="12">{yf(v)}</text>
            </g>
          );
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={L + (W - L - R) * f} x2={L + (W - L - R) * f} y1={T} y2={H - B} stroke="currentColor" className="text-border" strokeWidth="0.3" />
            <text x={L + (W - L - R) * f} y={H - 6} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="fill-muted" fontSize="12">{xTime ? <LocalDateTime iso={new Date(x0 + (x1 - x0) * f).toISOString()} options={xTime} /> : xf(x0 + (x1 - x0) * f)}</text>
          </g>
        ))}
        {zero && y0 < 0 && y1 > 0 && <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-muted" strokeDasharray="3 3" />}
        {vline !== undefined && vline >= x0 && vline <= x1 && <line x1={x(vline)} x2={x(vline)} y1={T} y2={H - B} stroke="currentColor" className="text-accent" strokeDasharray="2 3" />}
        {series.map((s) => (
          <polyline key={s.id} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" points={path(s)}>
            <title>{s.name}</title>
          </polyline>
        ))}
        {dots.map((d, i) => (
          <circle key={i} cx={x(d.x)} cy={y(d.y)} r={(d.r ?? 2.5) * 1.5} fill={d.color} fillOpacity="0.75" stroke="#0b1220" strokeWidth="0.8">
            {d.tip && <title>{d.tip}</title>}
          </circle>
        ))}
        {(xLabel || yLabel) && (
          <text x={W - R} y={T + 8} textAnchor="end" className="fill-muted" fontSize="10">{[yLabel, xLabel].filter(Boolean).join(" vs ")}</text>
        )}
      </svg>
      {legend && series.length > 1 && (
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
                <th className="py-0.5 text-right font-medium" title="DraftKings price, vig removed">DK</th>
                <th className="py-0.5 text-right font-medium" title="Kalshi's real-money price, the middle of its bid and ask">KS</th>
                <th className="py-0.5 text-right font-medium" title="The exchange's own price: size-weighted middle of the best bid and ask, else the last trade">Exch</th>
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
                  <td className="py-0.5 text-right text-muted">{pct(g.views?.kal?.find((x) => x[0] === r[0] && x[1] === r[1])?.[2])}</td>
                  <td className="py-0.5 text-right text-foreground">{pct(r[9])}</td>
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

export type MatrixRow = { key: string; label: string; cells: Record<string, { net: number; long: number; short: number }> };

/** Contracts down the side, syndicates across the top: the size of each net position, green for long yes, red for short yes. */
export function PositionMatrix({ rows, cols }: { rows: MatrixRow[]; cols: { id: string; name: string; color: string }[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => Object.values(r.cells).map((c) => Math.abs(c.net))));
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] text-[11px]">
        <thead className="bg-surface text-left text-muted">
          <tr>
            <th className="px-3 py-2">Contract</th>
            {cols.map((c) => (
              <th key={c.id} className="px-2 py-2 text-right font-medium">
                <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />
                {c.name.split(" ")[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <td className="px-3 py-1 font-sans text-foreground">{r.label}</td>
              {cols.map((c) => {
                const v = r.cells[c.id];
                const a = v ? Math.min(0.55, (Math.abs(v.net) / max) * 0.55) : 0;
                return (
                  <td
                    key={c.id}
                    className="px-2 py-1 text-right"
                    style={v && Math.abs(v.net) > 0.5 ? { background: `${v.net > 0 ? "rgba(34,197,94," : "rgba(239,68,68,"}${a})` } : undefined}
                    title={v ? `long ${v.long.toFixed(0)} · short ${v.short.toFixed(0)}` : undefined}
                  >
                    {v && Math.abs(v.net) > 0.5 ? `${v.net > 0 ? "+" : ""}${v.net.toFixed(0)}` : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Plain vertical bars, one per bucket, with the first and last labels underneath. */
export function Bars({ data, height = 120, color = "#38bdf8", fmt, timeOpts }: { data: { label?: string; ts?: number; v: number }[]; height?: number; color?: string; fmt?: (v: number) => string; timeOpts?: Intl.DateTimeFormatOptions }) {
  const lab = (d: { label?: string; ts?: number }) => (d.ts != null && timeOpts ? <LocalDateTime iso={new Date(d.ts).toISOString()} options={timeOpts} /> : d.label);
  if (!data.length) return <p className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-xs text-muted">Nothing to chart yet.</p>;
  const max = Math.max(1, ...data.map((d) => d.v));
  const W = 900, H = height, L = 8, B = 18, gap = 2;
  const bw = (W - L * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-border bg-surface">
      {data.map((d, i) => {
        const h = (d.v / max) * (H - B - 8);
        return (
          <rect key={i} x={L + i * bw + gap / 2} y={H - B - h} width={Math.max(1, bw - gap)} height={h} fill={color} fillOpacity="0.8" rx="1">
            <title>{`${d.label ? `${d.label}: ` : ""}${fmt ? fmt(d.v) : d.v}`}</title>
          </rect>
        );
      })}
      <text x={L} y={H - 4} className="fill-muted" fontSize="10">{lab(data[0])}</text>
      <text x={W - L} y={H - 4} textAnchor="end" className="fill-muted" fontSize="10">{lab(data[data.length - 1])}</text>
    </svg>
  );
}
