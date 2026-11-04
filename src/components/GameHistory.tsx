import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { getGameHistory } from "@/lib/gameHistory";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const STEP = 20; // rows shown at first, and added by each "show more"
const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
const tone = (n: number, eps = 0.05) => (n > eps ? "text-up" : n < -eps ? "text-down" : "text-muted");

/** One row per finished game the trader or firm traded: what was put up, what came back, the return, and the sides held. Closed until opened (it stays open after a filter or "show more"),
 * the latest 20 settled games at first, more on request, and a sport filter. `params` are the page's own query parameters, kept in every link. */
export async function GameHistory({ kind, id, memberIds, basePath, params }: { kind: "trader" | "firm"; id: string; memberIds: string[]; basePath: string; params: Record<string, string | undefined> }) {
  const all = params.hist === "all";
  const n = all ? null : Math.max(STEP, Math.min(400, Number(params.hist) || STEP));
  const sport = params.hsport && SPORT[params.hsport] ? params.hsport : null;
  const { rows, sports, total } = await getGameHistory({ kind, id, memberIds }, n, sport);
  const href = (change: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, ...change })) if (v) p.set(k, v);
    return `${basePath}?${p}#history`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  const shownN = rows.length;
  return (
    <details id="history" open={!!(params.hist || params.hsport)} className="mb-8 rounded-lg border border-border bg-surface/30">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">
        Game history
        <span className="ml-3 text-[11px] font-normal text-muted">
          {total.games} games{sport ? ` in ${SPORT[sport]}` : ""} · staked {total.staked.toFixed(0)} · returned {total.returned.toFixed(0)} ·{" "}
          <span className={tone(total.pnl)}>{u(total.pnl)} units{total.staked > 0 ? ` (${((total.pnl / total.staked) * 100).toFixed(1)}% ROI)` : ""}</span>
        </span>
      </summary>
      <div className="px-4 pb-4">
        <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-muted">
          Every finished game {kind === "firm" ? "this firm" : "this trader"} traded in, newest first. <strong>Staked</strong> is the units put at risk on all its trades on the game (a buyer&rsquo;s price, a seller&rsquo;s 1 minus the price, including
          positions netted off along the way); <strong>Returned</strong> is that plus the profit or loss; <strong>ROI</strong> is profit over staked. <strong>Sides</strong> are the net positions it held when the game ended, with the number of contracts.
          The totals above follow the sport filter.
        </p>
        {sports.length > 1 ? (
          <div className="mb-3 flex flex-wrap items-center gap-1 text-[11px]">
            <span className="mr-1 text-muted">Sport</span>
            <Link href={href({ hsport: undefined, hist: undefined })} className={chip(!sport)}>All</Link>
            {sports.map((s) => <Link key={s} href={href({ hsport: s, hist: undefined })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
        ) : null}
        {rows.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">No finished games{sport ? ` in ${SPORT[sport]}` : ""} yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Game</th>
                    <th className="px-3 py-2 text-right">Staked</th>
                    <th className="px-3 py-2 text-right">Returned</th>
                    <th className="px-3 py-2 text-right">P&amp;L</th>
                    <th className="px-3 py-2 text-right">ROI</th>
                    <th className="px-3 py-2">Sides held</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {rows.map((r) => (
                    <tr key={r.game} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 font-sans text-foreground">
                        <Link href={`/syndicates/games/${encodeURIComponent(r.game)}`} className="hover:text-accent">{r.teams}</Link>
                        <span className="ml-1.5 text-[10px] uppercase text-muted">{SPORT[r.sport]}</span>
                        <span className="block text-[10px] text-muted">
                          <LocalDateTime iso={r.kickoff} options={{ month: "short", day: "numeric" }} />
                          {r.score ? ` · final ${r.score}` : ""} · {r.trades} {r.trades === 1 ? "trade" : "trades"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-muted">{r.staked.toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right">{r.returned.toFixed(1)}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(r.pnl)}`}>{u(r.pnl)}</td>
                      <td className={`px-3 py-1.5 text-right ${r.roi == null ? "text-muted" : tone(r.roi, 0.0005)}`}>{r.roi == null ? "–" : `${(r.roi * 100).toFixed(1)}%`}</td>
                      <td className="px-3 py-1.5 font-sans text-[11px] text-muted">
                        {r.legs.length === 0 ? "flat" : (
                          <>
                            {r.legs.slice(0, 4).map((l, i) => (
                              <span key={`${l.kind}${l.line}`}>{i > 0 && " · "}<span className="text-foreground">{l.text}</span> ×{l.net.toFixed(0)}</span>
                            ))}
                            {r.legs.length > 4 ? ` · +${r.legs.length - 4} more` : ""}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-4 text-[11px] text-muted">
              <span>Showing {shownN} of {total.games}</span>
              {shownN < total.games ? <Link href={href({ hist: String(shownN + STEP) })} className="text-accent hover:underline">Show {Math.min(STEP, total.games - shownN)} more</Link> : null}
              {shownN < total.games ? <Link href={href({ hist: "all" })} className="text-accent hover:underline">Show all {total.games}</Link> : null}
              {shownN > STEP ? <Link href={href({ hist: String(STEP) })} className="text-accent hover:underline">Back to the latest {STEP}</Link> : null}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
