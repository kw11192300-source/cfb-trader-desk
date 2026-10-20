import Image from "next/image";
import LogBetForm from "./LogBetForm";
import LogPropBetForm from "./LogPropBetForm";
import type { GradedBet, NbaSnapshot } from "@/lib/data";
import { nbaLogo, nbaShort } from "@/lib/nbaTeams";
import type { Bet, Game } from "@/lib/types";

const ET = "America/New_York";
const sp = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n > 0 ? `+${n}` : `${n}`);
const px = (n: number | null | undefined) => (n === null || n === undefined ? "" : ` (${n > 0 ? "+" : ""}${n})`);
const ml = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n > 0 ? `+${n}` : `${n}`);

function fmtBet(bet: Bet): string {
  if (bet.market === "prop") return `${bet.player} ${bet.side} ${bet.line} ${bet.prop_type ?? ""}`.trim();
  if (bet.market === "moneyline") return `${bet.side} ML`;
  if (bet.market === "total") return `${bet.side === "over" ? "Over" : "Under"} ${bet.line}`;
  return `${bet.side} ${sp(bet.line)}`;
}

function Logo({ team }: { team: string }) {
  const src = nbaLogo(team);
  return src ? <Image src={src} alt="" width={26} height={26} className="shrink-0 object-contain" style={{ width: 26, height: 26 }} unoptimized /> : <span className="inline-block h-[26px] w-[26px] shrink-0 rounded-full bg-surface-raised" />;
}

/** One NBA game: score or tip time, the current lines (and where they opened), buttons to log a spread / moneyline / total / prop bet,
 * and the bets you already have on it. */
export default function NbaGameCard({ game, snaps, bets }: { game: Game; snaps: NbaSnapshot[]; bets: GradedBet[] }) {
  const cur = snaps.length ? snaps[snaps.length - 1] : null;
  const first = snaps.length ? snaps[0] : null;
  const live = game.live_status;
  const started = game.completed || live !== null;
  const hp = game.completed ? game.home_points : (live?.home_points ?? null);
  const ap = game.completed ? game.away_points : (live?.away_points ?? null);
  const status = game.completed
    ? "Final"
    : live
      ? `LIVE${live.detail ? ` · ${live.detail}` : ""}`
      : new Date(game.start_date).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });

  const homeLine = cur?.spread_home_line ?? null; // the home team's own number (negative = favoured)
  const total = cur?.total_line ?? null;
  const moved = (a: number | null | undefined, b: number | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && a !== b;

  const mine = bets.filter((b) => b.bet.game_id === game.id);
  const homeShort = nbaShort(game.home_team);
  const awayShort = nbaShort(game.away_team);

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
          <span className={live ? "font-medium text-down" : ""}>{status}</span>
          {game.season_type === "preseason" && <span className="rounded bg-surface-raised px-1.5 py-0.5">preseason</span>}
        </div>
        {([[game.away_team, ap, "away"], [game.home_team, hp, "home"]] as const).map(([team, pts, side]) => {
          const won = game.completed && hp !== null && ap !== null && (side === "home" ? hp > ap : ap > hp);
          return (
            <div key={side} className="flex items-center gap-2 py-0.5">
              <Logo team={team} />
              <span className={`flex-1 text-sm ${won ? "font-semibold text-foreground" : "text-foreground/90"}`}>{team}</span>
              {started && <span className={`font-mono text-lg ${won ? "font-semibold" : "text-muted"}`}>{pts ?? "—"}</span>}
              <span className="w-14 text-right font-mono text-[11px] text-muted">
                {side === "home" ? (homeLine !== null ? sp(homeLine) : "") : homeLine !== null ? sp(-homeLine) : ""}
              </span>
            </div>
          );
        })}
        {cur && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
            <span>
              Spread {homeShort} {sp(homeLine)}
              {px(cur.spread_home_odds)}
              {first && moved(first.spread_home_line, homeLine) ? <span className="text-foreground"> (opened {sp(first.spread_home_line)})</span> : null}
            </span>
            <span>
              Total {total ?? "—"}
              {px(cur.over_odds)}
              {first && moved(first.total_line, total) ? <span className="text-foreground"> (opened {first.total_line})</span> : null}
            </span>
            <span>
              ML {awayShort} {ml(cur.ml_away)} / {homeShort} {ml(cur.ml_home)}
            </span>
          </div>
        )}
        {!cur && !started && <div className="mt-2 text-[11px] text-muted">No line posted yet.</div>}
      </div>

      {!game.completed && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <LogBetForm
            gameId={game.id}
            sport="nba"
            modelVersion={null}
            market="spread"
            sideOptions={[
              { value: game.home_team, label: `${homeShort} ${sp(homeLine)}`, line: homeLine ?? 0 },
              { value: game.away_team, label: `${awayShort} ${homeLine !== null ? sp(-homeLine) : ""}`, line: homeLine !== null ? -homeLine : 0 },
            ]}
            line={homeLine ?? 0}
            buttonLabel="Spread"
            defaultEdgeSource="market"
          />
          <LogBetForm
            gameId={game.id}
            sport="nba"
            modelVersion={null}
            market="moneyline"
            sideOptions={[
              { value: game.home_team, label: `${homeShort} ${ml(cur?.ml_home)}`, line: 0 },
              { value: game.away_team, label: `${awayShort} ${ml(cur?.ml_away)}`, line: 0 },
            ]}
            line={0}
            buttonLabel="ML"
            defaultEdgeSource="market"
          />
          <LogBetForm
            gameId={game.id}
            sport="nba"
            modelVersion={null}
            market="total"
            sideOptions={[
              { value: "over", label: "Over" },
              { value: "under", label: "Under" },
            ]}
            line={total ?? 0}
            buttonLabel="Total"
            defaultEdgeSource="market"
          />
          <LogPropBetForm gameId={game.id} sport="nba" />
        </div>
      )}

      {mine.length > 0 && (
        <ul className="border-t border-border px-4 py-2 text-xs">
          {mine.map(({ bet, status: st, profit }) => (
            <li key={bet.id} className="flex items-center justify-between gap-3 py-0.5">
              <span className="text-foreground">
                {fmtBet(bet)} <span className="text-muted">{bet.odds > 0 ? `+${bet.odds}` : bet.odds} · {bet.stake}u</span>
              </span>
              <span className={`font-mono ${st === "win" ? "text-up" : st === "loss" ? "text-down" : st === "push" ? "text-muted" : "text-accent"}`}>
                {st === "pending" ? "PENDING" : `${st.toUpperCase()} ${profit !== null ? `${profit >= 0 ? "+" : ""}${profit.toFixed(2)}` : ""}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
