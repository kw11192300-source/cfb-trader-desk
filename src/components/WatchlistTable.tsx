import LocalDateTime from "./LocalDateTime";
import type { WatchlistRow } from "@/lib/data";

function fmtPts(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

function StatusBadge({ row }: { row: WatchlistRow }) {
  if (row.alert_sent_at) {
    return <span className="rounded-full bg-up/15 px-2 py-0.5 text-[11px] font-medium text-up">confirmed - alerted</span>;
  }
  const move = row.move_toward_pick ?? 0;
  if (move > 0) {
    return <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">moving your way</span>;
  }
  return <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-muted">watching</span>;
}

export default function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
        No candidates on the watchlist right now — run <code className="text-foreground">python -m modeling.watchlist</code>, or
        check back once teams have played their first game of the season.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2">Matchup</th>
            <th className="px-3 py-2">Pick</th>
            <th className="px-3 py-2 text-right">Edge</th>
            <th className="px-3 py-2 text-right">Reference</th>
            <th className="px-3 py-2 text-right">Current</th>
            <th className="px-3 py-2 text-right">Move</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Kickoff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border align-top">
              <td className="px-3 py-2 text-foreground">
                {r.awayTeam} @ {r.homeTeam}
                <div className="text-[11px] text-muted">wk {r.week}</div>
              </td>
              <td className="px-3 py-2 font-medium text-foreground">{r.pick_team}</td>
              <td className="px-3 py-2 text-right font-mono text-foreground">{(r.current_edge ?? r.edge).toFixed(1)}</td>
              <td className="px-3 py-2 text-right font-mono text-muted">{fmtPts(r.reference_spread)}</td>
              <td className="px-3 py-2 text-right font-mono text-foreground">{fmtPts(r.current_spread)}</td>
              <td className={`px-3 py-2 text-right font-mono font-medium ${(r.move_toward_pick ?? 0) > 0 ? "text-up" : "text-muted"}`}>
                {fmtPts(r.move_toward_pick)}
              </td>
              <td className="px-3 py-2">
                <StatusBadge row={r} />
              </td>
              <td className="px-3 py-2 text-[11px] text-muted">
                <LocalDateTime iso={r.startDate} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
