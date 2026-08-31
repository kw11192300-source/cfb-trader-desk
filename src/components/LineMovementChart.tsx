import { normalizeProviderName } from "@/lib/lines";
import type { LineSnapshot } from "@/lib/types";

// Cycled by book index — DraftKings/ESPN Bet/Bovada get the first three,
// anything beyond that (more books added later) still gets a distinct color.
const PALETTE = ["#3ba7ff", "#f59e0b", "#a855f7", "#22c55e", "#ef4444", "#14b8a6"];

const WIDTH = 640;
const HEIGHT = 160;
const PAD = 28;

function buildPath(points: { t: number; v: number }[], xDomain: [number, number], yDomain: [number, number]): string {
  const [xMin, xMax] = xDomain;
  const [yMin, yMax] = yDomain;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  return points
    .map((p, i) => {
      const x = PAD + ((p.t - xMin) / xSpan) * (WIDTH - PAD * 2);
      // SVG y grows downward; flip so a higher value plots higher.
      const y = HEIGHT - PAD - ((p.v - yMin) / ySpan) * (HEIGHT - PAD * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * Line chart of a value (spread or total) over every poll_lines.py capture,
 * one series per book. Static SVG (no client JS, no charting library) — a
 * hand-rolled path is plenty for a handful of points per book, and it stays
 * fast and dependency-free. Will look thin/flat early in the season since
 * poll_lines only started running once the sync went live; it fills in as
 * more snapshots accumulate.
 */
export default function LineMovementChart({ snapshots, field, label }: { snapshots: LineSnapshot[]; field: "spread" | "over_under"; label: string }) {
  const byBook = new Map<string, { t: number; v: number }[]>();
  for (const s of snapshots) {
    const value = s[field];
    if (value === null) continue;
    const book = normalizeProviderName(s.provider);
    const list = byBook.get(book) ?? [];
    list.push({ t: new Date(s.captured_at).getTime(), v: value });
    byBook.set(book, list);
  }
  const series = Array.from(byBook.entries());
  const allPoints = series.flatMap(([, pts]) => pts);

  if (allPoints.length === 0) {
    return <p className="text-xs text-muted">No {label.toLowerCase()} history captured yet.</p>;
  }

  const xMin = Math.min(...allPoints.map((p) => p.t));
  const xMax = Math.max(...allPoints.map((p) => p.t));
  const yValues = allPoints.map((p) => p.v);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  // Pad the value axis so a flat line (no movement yet) doesn't hug the edges.
  const yPad = Math.max((yMax - yMin) * 0.15, 0.5);

  const totalPoints = allPoints.length;
  if (totalPoints < 2) {
    return <p className="text-xs text-muted">Only one {label.toLowerCase()} snapshot so far — check back once more polls have run.</p>;
  }

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={`${label} movement over time`}>
        <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} />
        <line x1={PAD} y1={PAD} x2={PAD} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} />
        {series.map(([book, pts], i) => {
          const sorted = [...pts].sort((a, b) => a.t - b.t);
          const color = PALETTE[i % PALETTE.length];
          return (
            <g key={book}>
              <path d={buildPath(sorted, [xMin, xMax], [yMin - yPad, yMax + yPad])} fill="none" stroke={color} strokeWidth={2} />
              {sorted.map((p, j) => {
                const x = PAD + ((p.t - xMin) / (xMax - xMin || 1)) * (WIDTH - PAD * 2);
                const y = HEIGHT - PAD - ((p.v - (yMin - yPad)) / (yMax + yPad - (yMin - yPad) || 1)) * (HEIGHT - PAD * 2);
                return <circle key={j} cx={x} cy={y} r={2.5} fill={color} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {series.map(([book], i) => (
          <span key={book} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
            {book}
          </span>
        ))}
      </div>
    </div>
  );
}
