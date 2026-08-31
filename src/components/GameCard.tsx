import Link from "next/link";
import Image from "next/image";
import LocalDateTime from "./LocalDateTime";
import { formatSpread, normalizeProviderName, pickHeadlineLine, realBookLines, sortLines, spreadMovement, totalMovement } from "@/lib/lines";
import type { BoardRow } from "@/lib/types";

function TeamLogo({ src, alt, size = 28 }: { src: string | null; alt: string; size?: number }) {
  if (!src) return <div className="shrink-0 rounded-full bg-surface-raised" style={{ width: size, height: size }} />;
  return <Image src={src} alt={alt} width={size} height={size} className="shrink-0 object-contain" style={{ width: size, height: size }} unoptimized />;
}

function MoveTag({ delta, direction }: { delta: number; direction: "up" | "down" | "flat" }) {
  if (direction === "flat") return <span className="text-flat text-[11px]">flat</span>;
  const color = direction === "up" ? "text-up" : "text-down";
  const arrow = direction === "up" ? "▲" : "▼";
  return (
    <span className={`text-[11px] font-mono ${color}`}>
      {arrow} {Math.abs(delta).toFixed(1)}
    </span>
  );
}

export default function GameCard({ row }: { row: BoardRow }) {
  const { game, lines, homeLogo, awayLogo } = row;
  const headline = pickHeadlineLine(lines);
  const books = sortLines(realBookLines(lines));
  const sMove = headline ? spreadMovement(headline) : null;
  const tMove = headline ? totalMovement(headline) : null;

  return (
    <Link
      href={`/games/${game.id}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/60 hover:bg-surface-raised"
    >
      <div className="flex items-center justify-between text-[11px] text-muted">
        <LocalDateTime
          iso={game.start_date}
          options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
        />
        <span>{books.length} book{books.length === 1 ? "" : "s"}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <TeamLogo src={awayLogo} alt={game.away_team} />
          <span className="truncate text-sm text-foreground">{game.away_team}</span>
        </div>
        <div className="flex items-center gap-2">
          <TeamLogo src={homeLogo} alt={game.home_team} />
          <span className="truncate text-sm text-foreground">{game.home_team}</span>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <div>
          <div className="font-mono text-base text-foreground">
            {headline ? formatSpread(game.home_team, game.away_team, headline.spread) : "—"}
          </div>
          {sMove && <MoveTag delta={sMove.delta} direction={sMove.direction} />}
        </div>
        <div className="text-right">
          <div className="font-mono text-base text-foreground">
            {headline?.over_under !== null && headline?.over_under !== undefined ? `O/U ${headline.over_under.toFixed(1)}` : "—"}
          </div>
          {tMove && <MoveTag delta={tMove.delta} direction={tMove.direction} />}
        </div>
      </div>

      {books.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px] text-muted">
          {books.map((l) => (
            <span key={l.provider} className="font-mono">
              {normalizeProviderName(l.provider)} {l.spread !== null ? l.spread.toFixed(1) : "—"}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
