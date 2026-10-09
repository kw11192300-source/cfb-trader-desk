import ProbOdds from "./ProbOdds";
import { striped } from "@/lib/nhlColors";
import { pct } from "@/lib/nhlModel";

/** Win probability split four ways in team colors: solid = won in regulation, striped = won in overtime or the
 * shootout. Left to right: away regulation, away OT/SO, home OT/SO, home regulation. */
export default function NhlWinBar({
  home,
  away,
  homeColor,
  awayColor,
  pHome,
  pHomeReg,
  pTieReg,
}: {
  home: string;
  away: string;
  homeColor: string;
  awayColor: string;
  pHome: number;
  pHomeReg: number;
  pTieReg: number;
}) {
  const homeOt = Math.max(0, pHome - pHomeReg);
  const awayOt = Math.max(0, pTieReg - homeOt);
  const awayReg = Math.max(0, 1 - pHomeReg - pTieReg);
  const segs = [
    { label: `${away} in regulation`, p: awayReg, color: awayColor },
    { label: `${away} in OT/SO`, p: awayOt, color: striped(awayColor) },
    { label: `${home} in OT/SO`, p: homeOt, color: striped(homeColor) },
    { label: `${home} in regulation`, p: pHomeReg, color: homeColor },
  ];
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="text-foreground">
          {away}{" "}
          <span className="font-mono font-semibold">
            <ProbOdds p={1 - pHome} />
          </span>
        </span>
        <span className="text-foreground">
          <span className="font-mono font-semibold">
            <ProbOdds p={pHome} />
          </span>{" "}
          {home}
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-raised">
        {segs.map((s) => (
          <div key={s.label} title={`${s.label}: ${pct(s.p)}`} className="h-full" style={{ width: `${s.p * 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-[10px] text-muted">
        <span>
          solid = won in regulation · striped = won in OT / shootout
        </span>
        <span className="font-mono">
          {pct(awayReg)} · {pct(awayOt)} | {pct(homeOt)} · {pct(pHomeReg)}
        </span>
      </div>
    </div>
  );
}
