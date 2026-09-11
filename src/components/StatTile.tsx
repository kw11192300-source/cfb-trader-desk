/** Shared KPI-tile chrome — the "Record/Staked/Profit/ROI/Pending" pattern
 * BetsLedger already used, extracted so the Board pages' new stat strip
 * and BetsLedger's existing one look and behave identically. Deliberately
 * dumb: this component owns only the elevated card style + the
 * label/value type hierarchy, never any of the actual math (that stays in
 * each page/ledger, right next to the data it's summarizing). */
export default function StatTile({
  label,
  value,
  tone = "neutral",
  sub,
  title,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "neutral" | "accent";
  sub?: string;
  title?: string;
}) {
  const toneClass = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "accent" ? "text-accent" : "text-foreground";

  return (
    <div className="rounded-xl border border-border bg-surface p-3 shadow-card">
      <div className="text-[10px] font-medium font-mono uppercase tracking-wide text-muted" title={title}>
        {label}
      </div>
      <div className={`font-mono text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}
