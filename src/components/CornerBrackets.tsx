/** HUD-style corner ticks, absolutely positioned over a `relative`
 * parent's four corners - the "instrument panel" accent every terminal
 * mockup leans on. Deliberately reserved for a couple of hero panels
 * (KPI strip, the equity curve, a model-edge board card) rather than
 * every card, which would just be noise. Purely decorative - aria-hidden. */
export default function CornerBrackets({ tone = "accent" }: { tone?: "accent" | "gold" }) {
  const color = tone === "gold" ? "border-gold/80" : "border-accent/70";
  const base = `pointer-events-none absolute h-3 w-3 ${color}`;
  return (
    <span aria-hidden className="contents">
      <span className={`${base} top-0 left-0 border-t-2 border-l-2`} />
      <span className={`${base} top-0 right-0 border-t-2 border-r-2`} />
      <span className={`${base} bottom-0 left-0 border-b-2 border-l-2`} />
      <span className={`${base} bottom-0 right-0 border-b-2 border-r-2`} />
    </span>
  );
}
