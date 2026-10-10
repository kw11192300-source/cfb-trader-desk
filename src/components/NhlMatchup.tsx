import type { GoalieLine, MatchupLine } from "@/lib/nhlMatchup";
import NhlTeamLogo from "./NhlTeamLogo";

const Rank = ({ n }: { n: number | null }) => (n === null ? null : <span className={`ml-1.5 text-[10px] ${n <= 8 ? "text-accent" : n >= 25 ? "text-warn" : "text-muted"}`}>#{n}</span>);

/** The two teams side by side from the Teams and Goalies tables, each number with its league rank (#1 = best of 32). */
export default function NhlMatchup({
  home,
  away,
  lines,
  awayGoalies,
  homeGoalies,
}: {
  home: string;
  away: string;
  lines: MatchupLine[];
  awayGoalies: GoalieLine[];
  homeGoalies: GoalieLine[];
}) {
  if (lines.every((l) => l.away === "—" && l.home === "—")) {
    return <p className="text-xs text-muted">No team tables published yet - run Update data on the Teams page.</p>;
  }
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-3 py-1.5 text-right font-medium">
                <span className="flex items-center justify-end gap-2">
                  {away}
                  <NhlTeamLogo team={away} size={18} />
                </span>
              </th>
              <th className="px-3 py-1.5 text-center font-medium"> </th>
              <th className="px-3 py-1.5 text-left font-medium">
                <span className="flex items-center gap-2">
                  <NhlTeamLogo team={home} size={18} />
                  {home}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5 text-right font-mono text-foreground">
                  {l.away}
                  <Rank n={l.awayRank} />
                </td>
                <td className="px-3 py-1.5 text-center text-muted" title={l.hint}>
                  {l.label}
                </td>
                <td className="px-3 py-1.5 text-left font-mono text-foreground">
                  {l.home}
                  <Rank n={l.homeRank} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(awayGoalies.length > 0 || homeGoalies.length > 0) && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="px-3 py-1.5 text-left font-medium">Goalie in the model</th>
                <th className="px-3 py-1.5 text-right font-medium">Share</th>
                <th className="px-3 py-1.5 text-right font-medium">GP</th>
                <th className="px-3 py-1.5 text-right font-medium" title="Goals saved above expected this season">
                  GSAx
                </th>
                <th className="px-3 py-1.5 text-right font-medium">GSAx/100</th>
                <th className="px-3 py-1.5 text-right font-medium">Sv%</th>
                <th className="px-3 py-1.5 text-right font-medium" title="What the simulator uses: shrunk toward average">
                  Model rating
                </th>
              </tr>
            </thead>
            <tbody>
              {[...awayGoalies, ...homeGoalies].map((g) => (
                <tr key={`${g.team}-${g.name}`} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 text-foreground">
                    <span className="flex items-center gap-2">
                      <NhlTeamLogo team={g.team} size={16} />
                      {g.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted">{Math.round(g.weight * 100)}%</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{g.gp}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{g.gsax}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{g.gsaxPer100}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{g.svPct}</td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-foreground">{g.rating}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Ranks are among all 32 teams (#1 best; for xGA and penalty-kill numbers lower is better). Everything here comes from our own xG on the Teams and Goalies
        pages - descriptive, not a forecast.
      </p>
    </div>
  );
}
