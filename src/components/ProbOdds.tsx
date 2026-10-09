import { fairOdds, pct } from "@/lib/nhlModel";

/** A probability with its fair American price beside it: "57.3% (-134)". The price is no-vig - what the model
 * itself would have to be offered to break even - not a line any book is posting. */
export default function ProbOdds({ p, digits = 1, stacked = false }: { p: number; digits?: number; stacked?: boolean }) {
  const odds = <span className="font-normal text-muted">({fairOdds(p)})</span>;
  if (stacked) {
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <span>{pct(p, digits)}</span>
        <span className="text-[10px] font-normal text-muted">{fairOdds(p)}</span>
      </span>
    );
  }
  return (
    <>
      {pct(p, digits)} {odds}
    </>
  );
}
