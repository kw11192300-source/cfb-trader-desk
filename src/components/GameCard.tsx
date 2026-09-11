import Link from "next/link";
import Image from "next/image";
import CornerBrackets from "./CornerBrackets";
import LineSparkline from "./LineSparkline";
import LocalDateTime from "./LocalDateTime";
import { pickHeadlineLine as pickCfbdHeadline, spreadMovement, totalMovement } from "@/lib/lines";
import { formatPrice, formatSpread, mergeLines, pickHeadlineLine } from "@/lib/mergedLines";
import { fmtSpread, pickPerspectiveSpread } from "@/lib/spread";
import type { BoardRow, LineSnapshot } from "@/lib/types";

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

const BOOKS_PREVIEW = 3;

export default function GameCard({ row, sparklineSnapshots = [] }: { row: BoardRow; sparklineSnapshots?: LineSnapshot[] }) {
  const { game, lines, oddsApiLines, homeLogo, awayLogo, prediction } = row;
  const books = mergeLines(lines, oddsApiLines);
  const headline = pickHeadlineLine(books);

  // Movement still comes from CFBD's own tracked open/close (the only
  // source with that history) — a slightly different book than the
  // "current" headline below in rare cases, but the only real signal we
  // have for direction/size of the move.
  const cfbdHeadline = pickCfbdHeadline(lines);
  const sMove = cfbdHeadline ? spreadMovement(cfbdHeadline) : null;
  const tMove = cfbdHeadline ? totalMovement(cfbdHeadline) : null;

  // Model edge, if this game has a live prediction (only week-1 FBS-vs-FBS
  // games do right now - see predict_week1.py). Same pick-perspective math
  // as the Edges page: market − model = edge, always.
  const edge = prediction?.edge_spread ?? null;
  const hasModel = edge !== null && Math.abs(edge) > 0.05;
  const pickHome = hasModel ? edge > 0 : false;
  const pickTeam = pickHome ? game.home_team : game.away_team;
  const { market: modelMarketView, model: modelView } = hasModel
    ? pickPerspectiveSpread(prediction!.market_spread, prediction!.predicted_margin, pickHome)
    : { market: null, model: null };

  return (
    <Link
      href={`/games/${game.id}`}
      className={`relative flex flex-col gap-3 rounded-xl p-4 shadow-card transition-colors hover:bg-surface-raised hover:shadow-card-hover ${
        hasModel
          ? "gold-frame shadow-glow-gold hover:shadow-glow-gold"
          : "border border-accent/25 bg-surface hover:border-accent"
      }`}
    >
      {/* A model edge is the rarest, highest-signal thing on a 200-card
          board - gold, one step up from every other card's baseline
          amber, so it reads as "this one's actually worth a look"
          instead of blending into 200 identically-styled cards. */}
      {hasModel && <CornerBrackets tone="gold" />}
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
        <span>
          {books.length} book{books.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <TeamLogo src={awayLogo} alt={game.away_team} />
          <span className="flex-1 truncate text-sm text-foreground">{game.away_team}</span>
          {game.completed && game.away_points !== null && (
            <span className={`font-mono text-base ${(game.away_points ?? 0) > (game.home_points ?? 0) ? "font-bold text-foreground" : "text-muted"}`}>
              {game.away_points}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-sm text-foreground">{game.live_status.away_points}</span>}
        </div>
        <div className="flex items-center gap-2">
          <TeamLogo src={homeLogo} alt={game.home_team} />
          <span className="flex-1 truncate text-sm text-foreground">{game.home_team}</span>
          {game.completed && game.home_points !== null && (
            <span className={`font-mono text-base ${(game.home_points ?? 0) > (game.away_points ?? 0) ? "font-bold text-foreground" : "text-muted"}`}>
              {game.home_points}
            </span>
          )}
          {!game.completed && game.live_status && <span className="font-mono text-sm text-foreground">{game.live_status.home_points}</span>}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <div>
          <div className="font-mono text-lg font-semibold text-foreground">
            {headline ? formatSpread(game.home_team, game.away_team, headline.homeSpread) : "—"}
          </div>
          {headline?.homeSpreadPrice !== null && headline?.homeSpreadPrice !== undefined && (
            <div className="font-mono text-[11px] text-muted">{formatPrice(headline.homeSpreadPrice)}</div>
          )}
          <div className="mt-1 flex items-center gap-2">
            {sMove && <MoveTag delta={sMove.delta} direction={sMove.direction} />}
            <LineSparkline snapshots={sparklineSnapshots} />
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-semibold text-foreground">
            {headline?.total !== null && headline?.total !== undefined ? `O/U ${headline.total.toFixed(1)}` : "—"}
          </div>
          {headline?.overPrice !== null && headline?.overPrice !== undefined && (
            <div className="font-mono text-[11px] text-muted">
              o{formatPrice(headline.overPrice)} / u{formatPrice(headline.underPrice)}
            </div>
          )}
          {tMove && <MoveTag delta={tMove.delta} direction={tMove.direction} />}
        </div>
      </div>

      {hasModel && (
        <div className="flex items-center justify-between rounded-md border border-gold/30 bg-gold/10 px-2.5 py-1.5 text-[11px]">
          <span className="text-gold">
            Model likes <span className="font-medium">{pickTeam}</span>{" "}
            <span className="font-mono">{fmtSpread(modelView)}</span>
            <span className="text-muted"> (mkt {fmtSpread(modelMarketView)})</span>
          </span>
          <span className="font-mono font-bold text-gold">{Math.abs(edge!).toFixed(1)} edge</span>
        </div>
      )}

      {books.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px] text-muted">
          {books.slice(0, BOOKS_PREVIEW).map((l) => (
            <span key={l.bookKey} className="font-mono">
              {l.bookName} {l.homeSpread !== null ? l.homeSpread.toFixed(1) : "—"}
              {l.homeSpreadPrice !== null ? ` (${formatPrice(l.homeSpreadPrice)})` : ""}
            </span>
          ))}
          {books.length > BOOKS_PREVIEW && <span className="font-mono">+{books.length - BOOKS_PREVIEW} more</span>}
        </div>
      )}
    </Link>
  );
}
