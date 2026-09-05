import { fmtPct, fmtUnits, type BreakdownRow } from "@/lib/betBreakdown";

/** Shared by RiskDashboard (by source / by week) and BetsLedger (by week,
 * surfaced near the top so it's visible as new weeks' results land). */
export default function BreakdownTable({ title, rows, labelHeader = "Week" }: { title: string; rows: BreakdownRow[]; labelHeader?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No graded bets yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                <th className="pb-2 pr-3 font-medium">{labelHeader}</th>
                <th className="pb-2 pr-3 text-right font-medium">Record</th>
                <th className="pb-2 pr-3 text-right font-medium">Staked</th>
                <th className="pb-2 pr-3 text-right font-medium">Profit</th>
                <th className="pb-2 text-right font-medium">ROI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-border first:border-t-0">
                  <td className="py-2 pr-3 text-foreground">{r.label}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-muted">
                    {r.wins}-{r.losses}
                    {r.pushes > 0 ? `-${r.pushes}` : ""}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-foreground">{r.staked.toFixed(2)}u</td>
                  <td className={`py-2 pr-3 text-right font-mono text-xs font-medium ${r.profit >= 0 ? "text-up" : "text-down"}`}>
                    {fmtUnits(r.profit)}
                  </td>
                  <td className={`py-2 text-right font-mono text-xs font-medium ${(r.roi ?? 0) >= 0 ? "text-up" : "text-down"}`}>{fmtPct(r.roi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
