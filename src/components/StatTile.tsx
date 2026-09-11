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
  const stripeClass = tone === "up" ? "bg-up shadow-glow-up" : tone === "down" ? "bg-down shadow-glow-down" : tone === "accent" ? "bg-accent shadow-glow-accent" : "bg-border";

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface p-3 pl-4 shadow-card">
      <span className={`absolute top-0 left-0 h-full w-1 ${stripeClass}`} />
      <div className="text-[10px] font-medium font-mono uppercase tracking-wide text-muted" title={title}>
        {label}
      </div>
      <div className={`font-mono text-3xl font-bold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}
