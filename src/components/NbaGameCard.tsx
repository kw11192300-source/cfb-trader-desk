import Image from "next/image";
import type { ReactNode } from "react";
import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import NbaBetButtons from "./NbaBetButtons";
import type { GradedBet, NbaGameProjection, NbaInjury, NbaSnapshot } from "@/lib/data";
import { devig, fairOdds } from "@/lib/nbaProj";
import { nbaLogo, nbaShort } from "@/lib/nbaTeams";
import type { Bet, Game } from "@/lib/types";

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
const nameKey = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();

/** One team's line on the injury report: who is out / doubtful / questionable, each with his rating (net points per 100 he adds) so the
 * size of the news is visible at a glance. */
function InjuryLine({ team, rows, ratings, keyNames }: { team: string; rows: NbaInjury[]; ratings: Record<string, number>; keyNames?: Set<string> }) {
  const mine = rows.filter((r) => r.team === team);
  if (mine.length === 0) return null;
  if (mine.every((r) => r.player === "")) return <div className="text-[11px] text-muted">{nbaShort(team)}: report not submitted yet</div>;
  const show = (statuses: string[]) =>
    mine
      .filter((r) => r.player && statuses.includes(r.status) && !/g league|two-way/i.test(`${r.reason_cat ?? ""} ${r.reason_detail ?? ""}`) && (!keyNames || keyNames.has(nameKey(r.player))))
      .map((r) => {
        const net = ratings[nameKey(r.player)];
        return { r, net };
      })
      .sort((a, b) => (b.net ?? -99) - (a.net ?? -99));
  const out = show(["Out", "Doubtful"]);
  const q = show(["Questionable", "Probable"]);
  if (out.length === 0 && q.length === 0) return null;
  const fmt = (x: { r: NbaInjury; net: number | undefined }) => (
    <span key={x.r.player}>
      {x.r.player}
      {x.net !== undefined && <span className="font-mono text-muted"> ({x.net > 0 ? "+" : ""}{x.net.toFixed(1)})</span>}
      {x.r.reason_detail ? <span className="text-muted"> {x.r.reason_detail}</span> : null}
    </span>
  );
  const join = (xs: { r: NbaInjury; net: number | undefined }[]) => xs.map((x, i) => <span key={x.r.player}>{i > 0 ? ", " : ""}{fmt(x)}</span>);
  return (
    <div className="text-[11px] leading-snug">
      <span className="text-muted">{nbaShort(team)}: </span>
      {out.length > 0 && (
        <span className="text-down">
          Out {join(out)}
        </span>
      )}
      {out.length > 0 && q.length > 0 && <span className="text-muted"> · </span>}
      {q.length > 0 && <span className="text-warn">Q {join(q)}</span>}
    </div>
  );
}

export default function NbaGameCard({ game, snaps, bets, injuries = [], ratings = {}, projection, keyNames }: { game: Game; snaps: NbaSnapshot[]; bets: GradedBet[]; injuries?: NbaInjury[]; ratings?: Record<string, number>; projection?: NbaGameProjection; keyNames?: Set<string> }) {
  const cur = snaps.length ? snaps[snaps.length - 1] : null;
  const live = game.live_status;
  const started = game.completed || live !== null;
  const hp = game.completed ? game.home_points : (live?.home_points ?? null);
  const ap = game.completed ? game.away_points : (live?.away_points ?? null);
  const status: ReactNode = game.completed
    ? "Final"
    : live
      ? `LIVE${live.detail ? ` · ${live.detail}` : ""}`
      : <LocalDateTime iso={game.start_date} options={{ hour: "numeric", minute: "2-digit" }} />;

  const homeLine = cur?.spread_home_line ?? null; // the home team's own number (negative = favoured)
  const total = cur?.total_line ?? null;
  const mine = bets.filter((b) => b.bet.game_id === game.id);
  const homeShort = nbaShort(game.home_team);
  const awayShort = nbaShort(game.away_team);
  const model = projection?.detail?.model;
  const mktP = devig(cur?.ml_home, cur?.ml_away);
  const gap = projection?.gap ?? null;
  const news = projection?.news_move ?? null;
  const stale = news !== null && gap !== null && Math.abs(gap) >= 1 && Math.abs(news) >= 0.75;

  return (
    <div className="rounded-lg border border-border bg-surface">
      <Link href={`/nba/games/${game.id}`} className="block rounded-t-lg px-4 py-3 transition-colors hover:bg-surface-raised">
        <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
          <span className={live ? "font-medium text-down" : ""}>{status}</span>
          <span className="flex items-center gap-2">
            {game.season_type === "preseason" && <span className="rounded bg-surface-raised px-1.5 py-0.5">preseason</span>}
            <span className="text-accent">Open game →</span>
          </span>
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
            </span>
            <span>
              Total {total ?? "—"}
              {px(cur.over_odds)}
            </span>
            <span title="Percentages are the moneyline chances with the vig removed">
              ML {awayShort} {ml(cur.ml_away)}{mktP !== null ? ` (${Math.round((1 - mktP) * 100)}%)` : ""} / {homeShort} {ml(cur.ml_home)}{mktP !== null ? ` (${Math.round(mktP * 100)}%)` : ""}
            </span>
          </div>
        )}
        {!cur && !started && <div className="mt-2 text-[11px] text-muted">No line posted yet.</div>}
        {!game.completed && model && (
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
            <span>
              Model <span className="text-foreground">{homeShort} {sp(Math.round(-model.margin * 2) / 2)}</span>
            </span>
            <span>
              Total <span className="text-foreground">{model.total.toFixed(1)}</span>
            </span>
            <span>
              {homeShort} win <span className="text-foreground">{Math.round(model.p_home * 100)}% ({fairOdds(model.p_home)})</span>
            </span>
            {stale && <span className="rounded bg-warn/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-warn">news not in line</span>}
          </div>
        )}
        {!game.completed && injuries.length > 0 && (
          <div className="mt-2 space-y-0.5 border-t border-border/60 pt-2">
            <InjuryLine team={game.away_team} rows={injuries} ratings={ratings} keyNames={keyNames} />
            <InjuryLine team={game.home_team} rows={injuries} ratings={ratings} keyNames={keyNames} />
          </div>
        )}
      </Link>

      {!game.completed && (
        <div className="border-t border-border px-4 py-3">
          <NbaBetButtons game={game} cur={cur} />
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
