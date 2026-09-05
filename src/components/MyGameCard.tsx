import Link from "next/link";
import Image from "next/image";
import LocalDateTime from "./LocalDateTime";
import type { GradedBet } from "@/lib/data";
import type { Game } from "@/lib/types";

function TeamLogo({ src, alt, size = 28 }: { src: string | null; alt: string; size?: number }) {
  if (!src) return <div className="shrink-0 rounded-full bg-surface-raised" style={{ width: size, height: size }} />;
  return <Image src={src} alt={alt} width={size} height={size} className="shrink-0 object-contain" style={{ width: size, height: size }} unoptimized />;
}

const STATUS_STYLE: Record<string, string> = {
  win: "text-up",
  loss: "text-down",
  push: "text-muted",
  pending: "text-accent",
};

function fmtLine(n: number): string {
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

function fmtOdds(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export default function MyGameCard({
  game,
  bets,
  homeLogo,
  awayLogo,
}: {
  game: Game;
  bets: GradedBet[];
  homeLogo: string | null;
  awayLogo: string | null;
}) {
  return (
    <Link
      href={`/games/${game.id}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/60 hover:bg-surface-raised"
    >
      <div className="flex items-center justify-between text-[11px] text-muted">
        {game.completed ? (
          <span className="font-medium text-muted">FINAL</span>
        ) : game.live_status ? (
          <span className="flex items-center gap-1.5 font-medium text-down">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-down" />
            LIVE
            {game.live_status.detail && <span className="text-muted"> · {game.live_status.detail}</span>}
          </span>
        ) : (
          <LocalDateTime
            iso={game.start_date}
            options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
          />
        )}
        <span>wk {game.week}</span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <TeamLogo src={awayLogo} alt={game.away_team} />
          <span className="flex-1 truncate text-sm text-foreground">{game.away_team}</span>
          {game.completed && game.away_points !== null && (
            <span className={`font-mono text-sm ${(game.away_points ?? 0) > (game.home_points ?? 0) ? "font-semibold text-foreground" : "text-muted"}`}>
              {game.away_points}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-sm text-foreground">{game.live_status.away_points}</span>}
        </div>
        <div className="flex items-center gap-2">
          <TeamLogo src={homeLogo} alt={game.home_team} />
          <span className="flex-1 truncate text-sm text-foreground">{game.home_team}</span>
          {game.completed && game.home_points !== null && (
            <span className={`font-mono text-sm ${(game.home_points ?? 0) > (game.away_points ?? 0) ? "font-semibold text-foreground" : "text-muted"}`}>
              {game.home_points}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-sm text-foreground">{game.live_status.home_points}</span>}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        {bets.map(({ bet, status, profit }) => (
          <div key={bet.id} className="flex items-center justify-between text-xs">
            <span className="font-mono text-foreground">
              {bet.side} {bet.market !== "moneyline" ? fmtLine(bet.line) : ""} <span className="text-muted">{fmtOdds(bet.odds)}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-muted">{bet.stake.toFixed(2)}u</span>
              <span className={`font-medium uppercase ${STATUS_STYLE[status]}`}>{status}</span>
              {profit !== null && (
                <span className={`font-mono ${profit >= 0 ? "text-up" : "text-down"}`}>{profit >= 0 ? `+${profit.toFixed(2)}` : profit.toFixed(2)}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </Link>
  );
}
