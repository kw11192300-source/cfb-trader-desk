import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import NhlTeamLogo from "./NhlTeamLogo";
import { fmtOdds, pct } from "@/lib/nhlModel";
import { marketResult, type TeamGameRow } from "@/lib/nhlTeamGames";

const nick = (t: string) => t.split(" ").slice(-1)[0];
const num = (n: number) => (n % 1 === 0 ? n.toFixed(1) : String(n));
const fl = (n: number) => (n > 0 ? `+${n}` : `${n}`);

const th = "bg-surface-raised px-2.5 py-2 font-medium";
const group = "border-l border-border px-2.5 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted";
const td = "px-2.5 py-1.5 whitespace-nowrap";

/** One team's games as a log: what happened, what the model expected before, and where DraftKings closed. Upcoming games
 * come first (soonest first), then finished games newest first. */
export default function NhlTeamGamesTable({ rows, compact = false }: { rows: TeamGameRow[]; compact?: boolean }) {
  const upcoming = rows.filter((r) => !r.completed).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const done = rows.filter((r) => r.completed).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const ordered = [...upcoming, ...done];
  if (ordered.length === 0) return <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">No games to show.</div>;

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-raised">
            <th colSpan={2} className="px-2.5 py-1" />
            <th colSpan={3} className={group}>
              Actual
            </th>
            <th colSpan={3} className={group}>
              Our model (pre-game)
            </th>
            <th colSpan={3} className={group}>
              DraftKings close
            </th>
            <th colSpan={3} className={group}>
              Result vs the close
            </th>
          </tr>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
            <th className={th}>Date</th>
            <th className={th}>Opponent</th>
            <th className={`${th} border-l border-border text-right`}>Final</th>
            <th className={`${th} text-right`} title="Total goals in the game">
              Total
            </th>
            <th className={`${th} text-right`} title="Expected goals for - against, all situations, live-net chances">
              xG
            </th>
            <th className={`${th} border-l border-border text-right`} title="The model's win probability for this team before the game">
              Win
            </th>
            <th className={`${th} text-right`} title="Expected goals for - against">
              Exp. goals
            </th>
            <th className={`${th} text-right`} title="Expected total goals">
              Exp. total
            </th>
            <th className={`${th} border-l border-border text-right`}>ML</th>
            <th className={`${th} text-right`} title="This team's puck line and its price">
              Puck line
            </th>
            <th className={`${th} text-right`} title="The total and the over price">
              Total
            </th>
            <th className={`${th} border-l border-border text-center`}>ML</th>
            <th className={`${th} text-center`}>Puck</th>
            <th className={`${th} text-center`}>O/U</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r, i) => {
            const res = marketResult(r);
            const margin = r.teamPts !== null && r.oppPts !== null ? r.teamPts - r.oppPts : null;
            const showDivider = !compact && i === upcoming.length && upcoming.length > 0;
            return (
              <tr key={r.gameId} className={`border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised ${showDivider ? "border-t-2 border-t-border" : ""}`}>
                <td className={`${td} text-muted`}>
                  <LocalDateTime iso={r.startDate} options={r.completed ? { month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                </td>
                <td className={td}>
                  <Link href={`/nhl/games/${r.gameId}`} prefetch={false} className="flex items-center gap-1.5 text-foreground hover:underline">
                    <span className="w-4 text-muted">{r.isHome ? "vs" : "@"}</span>
                    <NhlTeamLogo team={r.opp} size={16} />
                    {nick(r.opp)}
                  </Link>
                </td>

                <td className={`${td} border-l border-border text-right font-mono`}>
                  {r.completed && margin !== null ? (
                    <span className={margin > 0 ? "text-up" : "text-down"}>
                      {margin > 0 ? "W" : "L"} {r.teamPts}–{r.oppPts}
                    </span>
                  ) : r.live ? (
                    <span className="text-warn">live</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className={`${td} text-right font-mono text-foreground`}>{r.completed && r.teamPts !== null && r.oppPts !== null ? r.teamPts + r.oppPts : "—"}</td>
                <td className={`${td} text-right font-mono`}>
                  {r.xgFor !== null && r.xgAgainst !== null ? (
                    <span className={r.xgFor >= r.xgAgainst ? "text-up" : "text-down"}>
                      {r.xgFor.toFixed(1)}–{r.xgAgainst.toFixed(1)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>

                <td className={`${td} border-l border-border text-right font-mono text-foreground`}>{r.model ? pct(r.model.win, 0) : <span className="text-muted">—</span>}</td>
                <td className={`${td} text-right font-mono text-foreground`}>{r.model ? `${r.model.expFor.toFixed(1)}–${r.model.expAgainst.toFixed(1)}` : <span className="text-muted">—</span>}</td>
                <td className={`${td} text-right font-mono text-foreground`}>{r.model ? r.model.expTotal.toFixed(1) : <span className="text-muted">—</span>}</td>

                <td className={`${td} border-l border-border text-right font-mono text-foreground`}>{r.close?.ml !== null && r.close?.ml !== undefined ? fmtOdds(r.close.ml) : <span className="text-muted">—</span>}</td>
                <td className={`${td} text-right font-mono text-foreground`}>
                  {r.close?.puckLine !== null && r.close?.puckLine !== undefined ? (
                    <>
                      {fl(r.close.puckLine)} <span className="text-muted">{r.close.puckOdds !== null ? fmtOdds(r.close.puckOdds) : ""}</span>
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className={`${td} text-right font-mono text-foreground`}>
                  {r.close?.totalLine !== null && r.close?.totalLine !== undefined ? (
                    <>
                      {num(r.close.totalLine)} <span className="text-muted">o{r.close.over !== null ? fmtOdds(r.close.over) : ""}</span>
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>

                <td className={`${td} border-l border-border text-center font-mono`}>
                  {res.ml ? <span className={res.ml === "win" ? "text-up" : "text-down"}>{res.ml === "win" ? "W" : "L"}</span> : <span className="text-muted">—</span>}
                </td>
                <td className={`${td} text-center font-mono`}>
                  {res.puck ? <span className={res.puck === "cover" ? "text-up" : "text-down"}>{res.puck === "cover" ? "✓" : "✗"}</span> : <span className="text-muted">—</span>}
                </td>
                <td className={`${td} text-center font-mono`}>
                  {res.total ? <span className={res.total === "over" ? "text-up" : res.total === "under" ? "text-down" : "text-muted"}>{res.total === "over" ? "O" : res.total === "under" ? "U" : "P"}</span> : <span className="text-muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
