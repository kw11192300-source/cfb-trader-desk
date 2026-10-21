import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import type { GradedBet } from "@/lib/data";
import { nbaShort } from "@/lib/nbaTeams";
import { etDay } from "@/lib/nhlTeamGames";
import type { Bet, Game } from "@/lib/types";

const sp = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const units = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}u`;

function describe(b: Bet): string {
  if (b.market === "prop") return `${b.player ?? ""} ${b.side} ${b.line} ${b.prop_type ?? ""}`.trim();
  if (b.market === "moneyline") return `${b.side} ML`;
  if (b.market === "total") return `${b.side === "over" ? "Over" : "Under"} ${b.line}`;
  if (b.market === "parlay") return b.side;
  return `${b.side} ${sp(b.line)}`;
}
const marketLabel = (m: string) => (m === "moneyline" ? "ML" : m === "prop" ? "Prop" : m === "parlay" ? "Parlay" : m === "total" ? "Total" : "Spread");

function BetRow({ g }: { g: GradedBet }) {
  const { bet, status, profit } = g;
  const tone = status === "win" ? "text-up" : status === "loss" ? "text-down" : status === "push" ? "text-muted" : "text-accent";
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1">
      <span className="min-w-0 text-foreground">
        <span className="mr-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{marketLabel(bet.market)}</span>
        {describe(bet)}
        {bet.legs && bet.legs.length > 0 && <span className="block pl-1 text-[11px] text-muted">{bet.legs.join(" · ")}</span>}
      </span>
      <span className="flex items-baseline gap-3 font-mono text-[11px]">
        <span className="text-muted">
          {sp(bet.odds)} · {bet.stake}u{bet.sportsbook ? ` · ${bet.sportsbook}` : ""}
        </span>
        <span className={`w-24 text-right ${tone}`}>{status === "pending" ? "PENDING" : `${status.toUpperCase()} ${profit !== null ? units(profit) : ""}`}</span>
      </span>
    </li>
  );
}

/** Every NBA bet you have on one day's slate in one card, grouped by game and ordered by tip time (so the next game up is first), with
 * a one-line summary of what is risked and what has settled. Parlays span several games, so they are listed at the end under the day
 * they were placed. */
export default function NbaDayBets({ games, bets, day }: { games: Game[]; bets: GradedBet[]; day: string }) {
  const byGame = new Map<number, GradedBet[]>();
  const ids = new Set(games.map((g) => g.id));
  for (const b of bets) {
    if (b.bet.game_id !== null && ids.has(b.bet.game_id)) byGame.set(b.bet.game_id, [...(byGame.get(b.bet.game_id) ?? []), b]);
  }
  const parlays = bets.filter((b) => b.bet.market === "parlay" && b.bet.game_id === null && etDay(b.bet.placed_at) === day);
  const ordered = [...games].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()).filter((g) => byGame.has(g.id));
  const all = [...ordered.flatMap((g) => byGame.get(g.id) ?? []), ...parlays];
  if (all.length === 0) return null;

  const staked = all.reduce((s, b) => s + b.bet.stake, 0);
  const settled = all.filter((b) => b.status !== "pending");
  const net = settled.reduce((s, b) => s + (b.profit ?? 0), 0);
  const pending = all.filter((b) => b.status === "pending");
  const wins = settled.filter((b) => b.status === "win").length;
  const losses = settled.filter((b) => b.status === "loss").length;
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">Your bets · {label}</h2>
        <span className="font-mono text-[11px] text-muted">
          {all.length} bet{all.length === 1 ? "" : "s"} · {staked.toFixed(2)}u risked
          {pending.length > 0 && <> · {pending.reduce((s, b) => s + b.bet.stake, 0).toFixed(2)}u pending ({pending.length})</>}
          {settled.length > 0 && (
            <>
              {" "}
              · settled{" "}
              <span className={net > 0 ? "text-up" : net < 0 ? "text-down" : "text-foreground"}>{units(net)}</span> ({wins}-{losses}
              {settled.length - wins - losses > 0 ? `-${settled.length - wins - losses}` : ""})
            </>
          )}
        </span>
      </div>
      <div className="divide-y divide-border/60 text-xs">
        {ordered.map((g) => {
          const live = g.live_status !== null && !g.completed;
          return (
            <div key={g.id} className="px-4 py-2">
              <div className="mb-0.5 flex items-baseline justify-between gap-3">
                <Link href={`/nba/games/${g.id}`} className="font-medium text-foreground hover:underline">
                  {nbaShort(g.away_team)} @ {nbaShort(g.home_team)}
                </Link>
                <span className={`text-[11px] ${live ? "font-medium text-down" : "text-muted"}`}>
                  {g.completed
                    ? `Final ${g.away_points ?? "—"}-${g.home_points ?? "—"}`
                    : live
                      ? `LIVE${g.live_status?.detail ? ` · ${g.live_status.detail}` : ""}`
                      : <LocalDateTime iso={g.start_date} options={{ hour: "numeric", minute: "2-digit" }} />}
                </span>
              </div>
              <ul>
                {(byGame.get(g.id) ?? []).map((b) => (
                  <BetRow key={b.bet.id} g={b} />
                ))}
              </ul>
            </div>
          );
        })}
        {parlays.length > 0 && (
          <div className="px-4 py-2">
            <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted">Parlays placed this day</div>
            <ul>
              {parlays.map((b) => (
                <BetRow key={b.bet.id} g={b} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
