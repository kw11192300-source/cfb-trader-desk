import type { LineSnapshot } from "@/lib/types";

const W = 64;
const H = 20;
const PAD = 2;

/** Tiny inline-SVG line-movement sparkline for a Board card - same
 * scaling-math shape as LineMovementChart, shrunk down and single-series
 * (spread only, across all books/providers combined - a card has no room
 * for LineMovementChart's per-book legend). Renders nothing with fewer
 * than 2 spread snapshots, same "skip rather than show an empty/flat
 * chart" rule LineMovementChart already follows. */
export default function LineSparkline({ snapshots }: { snapshots: LineSnapshot[] }) {
  const points = snapshots
    .filter((s) => s.spread !== null)
    .map((s) => ({ t: new Date(s.captured_at).getTime(), v: s.spread as number }))
    .sort((a, b) => a.t - b.t);

  if (points.length < 2) return null;

  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.v);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const path = points
    .map((p, i) => {
      const x = PAD + ((p.t - xMin) / xSpan) * (W - PAD * 2);
      const y = H - PAD - ((p.v - yMin) / ySpan) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const moved = Math.abs(points[points.length - 1].v - points[0].v) >= 0.5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" role="img" aria-label="Spread movement">
      <path d={path} fill="none" stroke={moved ? "var(--accent)" : "var(--muted)"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
