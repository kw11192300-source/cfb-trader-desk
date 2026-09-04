import BacktestGamesTable from "./BacktestGamesTable";
import type { ModelBacktest, ModelBacktestGame } from "@/lib/types";

const BREAK_EVEN = 0.524;

function SeasonChart({ rows }: { rows: ModelBacktest[] }) {
  if (rows.length === 0) return null;
  const W = 760;
  const H = 220;
  const padL = 40;
  const padB = 26;
  const padT = 12;
  const plotW = W - padL - 10;
  const plotH = H - padT - padB;
  const barGap = 8;
  const barW = (plotW - barGap * (rows.length - 1)) / rows.length;
  const maxVal = Math.max(0.8, ...rows.map((r) => r.win_rate));

  const y = (v: number) => padT + plotH - v * plotH * (1 / maxVal);
  const beY = y(BREAK_EVEN);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 260 }}>
      {/* gridlines at 0/25/50/75% */}
      {[0, 0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={padL} x2={W - 10} y1={y(g)} y2={y(g)} stroke="var(--border)" strokeWidth={1} />
      ))}
      {[0, 0.25, 0.5, 0.75].map((g) => (
        <text key={g} x={padL - 8} y={y(g) + 4} textAnchor="end" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">
          {Math.round(g * 100)}%
        </text>
      ))}
      {/* break-even line */}
      <line x1={padL} x2={W - 10} y1={beY} y2={beY} stroke="var(--down)" strokeWidth={1.2} strokeDasharray="4 3" opacity={0.7} />
      <text x={W - 10} y={beY - 4} textAnchor="end" fontSize={10} fill="var(--down)" fontFamily="var(--font-mono)">
        52.4% break-even
      </text>
      {/* bars */}
      {rows.map((r, i) => {
        const x = padL + i * (barW + barGap);
        const barTop = y(r.win_rate);
        const barH = padT + plotH - barTop;
        const above = r.win_rate >= BREAK_EVEN;
        return (
          <g key={r.label}>
            <rect x={x} y={barTop} width={barW} height={Math.max(barH, 1)} fill={above ? "var(--up)" : "var(--down)"} opacity={0.75} rx={2} />
            <text x={x + barW / 2} y={barTop - 5} textAnchor="middle" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--foreground)">
              {(r.win_rate * 100).toFixed(0)}%
            </text>
            <text x={x + barW / 2} y={padT + plotH + 16} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)" fill="var(--muted)">
              {r.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function BreakdownTable({ title, rows, note }: { title: string; rows: ModelBacktest[]; note?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {note && <p className="mb-3 text-[11px] text-muted">{note}</p>}
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((r) => {
            const above = r.win_rate >= BREAK_EVEN;
            return (
              <tr key={r.label} className="border-t border-border first:border-t-0">
                <td className="py-2 pr-3 text-foreground">{r.label.replace(/_/g, " ")}</td>
                <td className="py-2 pr-3 text-right font-mono text-xs text-muted">n={r.n}</td>
                <td className={`py-2 text-right font-mono font-medium ${above ? "text-up" : "text-down"}`}>{(r.win_rate * 100).toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function EdgeBacktestPanel({
  results,
  games,
}: {
  results: Record<string, ModelBacktest[]>;
  games: ModelBacktestGame[];
}) {
  const seasonRows = results["season_win_rate"] ?? [];
  const matchupRows = results["matchup_type"] ?? [];
  const biasRows = results["bias_check"] ?? [];
  const edgeBucketRows = results["edge_bucket"] ?? [];
  const edgeTypeRows = results["edge_type"] ?? [];

  if (seasonRows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
        No backtest results yet — run <code className="text-foreground">python -m modeling.backtest_week1</code>.
      </div>
    );
  }

  const totalN = seasonRows.reduce((s, r) => s + r.n, 0);
  const totalWins = seasonRows.reduce((s, r) => s + r.win_rate * r.n, 0);
  const overallRate = totalN > 0 ? totalWins / totalN : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Top-15-by-edge win rate, FBS vs FBS week-1 games, walk-forward
          </h3>
          <span className="font-mono text-sm">
            <span className={overallRate >= BREAK_EVEN ? "text-up" : "text-down"}>{(overallRate * 100).toFixed(1)}%</span>
            <span className="text-muted"> overall (n={totalN})</span>
          </span>
        </div>
        <SeasonChart rows={seasonRows} />
        <p className="mt-2 text-[11px] text-muted">
          Each season trained only on strictly earlier seasons (no lookahead). The rightmost bar is the first season not used to discover this
          strategy in the first place — the one that actually matters.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <BreakdownTable
          title="Why FBS-vs-FBS only"
          rows={matchupRows}
          note="Same top-15-by-edge selection, split by matchup type. Buy games and FCS-vs-FCS showed no edge in isolation."
        />
        <BreakdownTable
          title="Bias check"
          rows={biasRows}
          note="Is this just always taking the points, or always the home team? Near-identical rates each way says no."
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {edgeBucketRows.length > 0 && (
          <BreakdownTable
            title="Win rate by edge size"
            rows={edgeBucketRows}
            note="How much the model and market disagreed, in points — the number cited in each pick's rationale on the Edges page."
          />
        )}
        {edgeTypeRows.length > 0 && (
          <BreakdownTable
            title="Closing line vs. opening line"
            rows={edgeTypeRows}
            note="Same top-15-by-edge selection, graded against the closing number (headline result above) vs. the opener — does it still hold up betting early in the week? Opening-line data only exists 2021+ and covers ~40% of games even then, so this is a smaller, noisier sample than the headline result, not a like-for-like replacement of it."
          />
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Every graded game</h3>
        <p className="mb-3 text-[11px] text-muted">
          All week-1 games 2016-2025, every matchup type — defaults to just the top-15-by-edge pool actually bet each season. Widen the filters
          to see the games that got left out (and why). Click a row for the model&apos;s reasoning on that specific pick, same rationale format
          as the Edges page.
        </p>
        <BacktestGamesTable games={games} />
      </div>
    </div>
  );
}
