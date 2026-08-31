import Image from "next/image";
import LocalDateTime from "./LocalDateTime";
import { formatMoneyline, formatSpread, spreadMovement, totalMovement } from "@/lib/lines";
import type { BoardRow } from "@/lib/types";

function MovementBadge({ delta, direction, decimals = 1 }: { delta: number; direction: "up" | "down" | "flat"; decimals?: number }) {
  if (direction === "flat") return <span className="text-flat text-xs">flat</span>;
  const color = direction === "up" ? "text-up" : "text-down";
  const arrow = direction === "up" ? "▲" : "▼";
  return (
    <span className={`text-xs font-mono ${color}`}>
      {arrow} {Math.abs(delta).toFixed(decimals)}
    </span>
  );
}

function TeamLogo({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <div className="h-6 w-6 shrink-0 rounded-full bg-surface-raised" />;
  return (
    <Image
      src={src}
      alt={alt}
      width={24}
      height={24}
      className="h-6 w-6 shrink-0 object-contain"
      unoptimized
    />
  );
}

export default function TraderBoard({ rows }: { rows: BoardRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
        No games found for the current week yet — check back once this week's slate has synced.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[860px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
            <th className="px-4 py-3 font-medium">Matchup</th>
            <th className="px-4 py-3 font-medium">Kickoff</th>
            <th className="px-4 py-3 font-medium">Spread</th>
            <th className="px-4 py-3 font-medium">Move</th>
            <th className="px-4 py-3 font-medium">Total</th>
            <th className="px-4 py-3 font-medium">Move</th>
            <th className="px-4 py-3 font-medium">ML (H/A)</th>
            <th className="px-4 py-3 font-medium">Book</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ game, line, homeLogo, awayLogo }) => {
            const sMove = line ? spreadMovement(line) : null;
            const tMove = line ? totalMovement(line) : null;
            return (
              <tr key={game.id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <TeamLogo src={awayLogo} alt={game.away_team} />
                    <span className="text-foreground">{game.away_team}</span>
                    <span className="text-muted">@</span>
                    <TeamLogo src={homeLogo} alt={game.home_team} />
                    <span className="text-foreground">{game.home_team}</span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted">
                  <LocalDateTime
                    iso={game.start_date}
                    options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-foreground">
                  {line ? formatSpread(game.home_team, game.away_team, line.spread) : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {sMove ? <MovementBadge delta={sMove.delta} direction={sMove.direction} /> : <span className="text-muted text-xs">—</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-foreground">
                  {line?.over_under !== null && line?.over_under !== undefined ? line.over_under.toFixed(1) : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {tMove ? <MovementBadge delta={tMove.delta} direction={tMove.direction} /> : <span className="text-muted text-xs">—</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-muted">
                  {line ? `${formatMoneyline(line.home_moneyline)} / ${formatMoneyline(line.away_moneyline)}` : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{line?.provider ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
