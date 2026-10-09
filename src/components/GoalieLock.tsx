"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setNhlGoalies } from "@/lib/actions";
import { pct } from "@/lib/nhlModel";
import type { GoalieSource, NhlGoalie, NhlPrediction } from "@/lib/types";

type Assumptions = NonNullable<NhlPrediction["assumptions"]>;

const SOURCE_LABEL: Record<GoalieSource, string> = {
  locked: "Locked by you",
  espn_confirmed: "ESPN: confirmed",
  espn_expected: "ESPN: expected",
  usage: "Our guess (recent starts)",
};

function initial(side: "home" | "away", a: Assumptions): string {
  if (a.sources?.[side] === "locked") return String(a.goalies[side][0]?.id ?? 0);
  return "auto";
}

/** Who's in net for each team, where that came from, and - when `canLock` - a way to lock in the confirmed
 * starters, which re-simulates the game on the spot. */
export default function GoalieLock({
  gameId,
  home,
  away,
  assumptions,
  canLock,
}: {
  gameId: number;
  home: string;
  away: string;
  assumptions: Assumptions;
  canLock: boolean;
}) {
  const router = useRouter();
  const [sel, setSel] = useState({ home: initial("home", assumptions), away: initial("away", assumptions) });
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const parse = (v: string): number | null => (v === "auto" ? null : Number(v));
  const allAuto = sel.home === "auto" && sel.away === "auto";

  return (
    <div>
      <div className="grid gap-4 text-xs sm:grid-cols-2">
        {(
          [
            ["away", away],
            ["home", home],
          ] as const
        ).map(([side, team]) => {
          const goalies: NhlGoalie[] = assumptions.goalies[side];
          const source = assumptions.sources?.[side];
          const pool = assumptions.pool?.[side] ?? [];
          return (
            <div key={side}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{team}</span>
                {source && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${assumptions.confirmed?.[side] ? "bg-accent/15 text-accent" : "bg-surface-raised text-muted"}`}
                  >
                    {SOURCE_LABEL[source]}
                  </span>
                )}
              </div>
              {goalies.length === 0 && <div className="text-muted">No starter on file.</div>}
              {goalies.map((g) => (
                <div key={`${g.id}-${g.name}`} className="flex items-center justify-between gap-3 py-0.5">
                  <span className="text-foreground">
                    {g.name} {goalies.length > 1 && <span className="font-mono text-muted">{pct(g.weight, 0)}</span>}
                  </span>
                  <span className="font-mono text-muted" title="Goals saved above expected per 100 shot attempts, shrunk toward average">
                    {g.rating >= 0 ? "+" : ""}
                    {g.rating.toFixed(2)}
                  </span>
                </div>
              ))}
              {canLock && (
                <select
                  value={sel[side]}
                  onChange={(e) => setSel((s) => ({ ...s, [side]: e.target.value }))}
                  className="mt-2 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
                >
                  <option value="auto">Auto - ESPN / our estimate</option>
                  {pool.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      Lock: {p.name} ({p.rating >= 0 ? "+" : ""}
                      {p.rating.toFixed(2)})
                    </option>
                  ))}
                  <option value="0">Lock: someone not listed (league average)</option>
                </select>
              )}
            </div>
          );
        })}
      </div>

      {canLock && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await setNhlGoalies(gameId, parse(sel.home), parse(sel.away));
                setMessage(r.message);
                if (r.ok) router.refresh();
              })
            }
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Re-simulating…" : allAuto ? "Reset to estimate" : "Lock & re-simulate"}
          </button>
          {message && <span className="text-xs text-muted">{message}</span>}
        </div>
      )}
    </div>
  );
}
