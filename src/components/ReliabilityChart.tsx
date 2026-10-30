import type { RelBin } from "@/lib/syndicates";

export type RelSeries = { name: string; color: string; bins: RelBin[] };

/** Reliability diagram: price on the bottom, how often it happened up the side. A perfect source sits on the diagonal; above it, the side won more often than the price said. */
export function ReliabilityChart({ series, size = 360 }: { series: RelSeries[]; size?: number }) {
  const L = 40, B = 30, T = 10, R = 10;
  const W = size, H = size;
  const x = (v: number) => L + v * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const maxN = Math.max(1, ...series.flatMap((s) => s.bins.map((b) => b.n)));
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label="Reliability diagram">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={y(0)} y2={y(1)} className="stroke-border" strokeWidth={0.5} />
            <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={0.5} />
            <text x={x(t)} y={H - 12} textAnchor="middle" className="fill-muted" fontSize={9}>{Math.round(t * 100)}¢</text>
            <text x={L - 5} y={y(t) + 3} textAnchor="end" className="fill-muted" fontSize={9}>{Math.round(t * 100)}%</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="stroke-muted" strokeWidth={1} strokeDasharray="4 3" />
        <text x={W / 2} y={H - 1} textAnchor="middle" className="fill-muted" fontSize={9}>price (what the side cost)</text>
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.color} strokeWidth={1.2} opacity={0.6} points={s.bins.map((b) => `${x(b.p).toFixed(1)},${y(b.f).toFixed(1)}`).join(" ")} />
            {s.bins.map((b) => {
              const se = 1.96 * Math.sqrt(Math.max(0.0025, b.f * (1 - b.f)) / b.n);
              return (
                <g key={b.bin}>
                  <line x1={x(b.p)} x2={x(b.p)} y1={y(Math.min(1, b.f + se))} y2={y(Math.max(0, b.f - se))} stroke={s.color} strokeWidth={1} opacity={0.5} />
                  <circle cx={x(b.p)} cy={y(b.f)} r={2.5 + 5 * Math.sqrt(b.n / maxN)} fill={s.color} opacity={0.85}>
                    <title>{`${s.name}: paid ${(b.p * 100).toFixed(1)}¢ avg, happened ${(b.f * 100).toFixed(1)}% (${b.n} trades, ${b.w.toFixed(0)} contracts)`}</title>
                  </circle>
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted">
        {series.map((s) => <span key={s.name}><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}</span>)}
      </div>
    </div>
  );
}
