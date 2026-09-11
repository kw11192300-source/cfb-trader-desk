import GameCard from "./GameCard";
import type { BoardRow, LineSnapshot } from "@/lib/types";

export default function TraderBoard({ rows, lineHistory }: { rows: BoardRow[]; lineHistory?: Map<number, LineSnapshot[]> }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 shadow-card text-center text-muted">
        No games found for the current week yet — check back once this week&apos;s slate has synced.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((row) => (
        <GameCard key={row.game.id} row={row} sparklineSnapshots={lineHistory?.get(row.game.id) ?? []} />
      ))}
    </div>
  );
}
