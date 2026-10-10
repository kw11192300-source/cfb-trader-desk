"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reinstateGoalie, ruleOutGoalie } from "@/lib/actions";
import type { NhlGoalieUnavailable } from "@/lib/types";

export type GoalieOption = { id: number; name: string; team: string | null };

const inputCls = "rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none";

/** Tell the model a goalie can't play: for the season (leave the date blank) or until a date. He is dropped from every team's
 * starter probabilities, the lock-in lists and the season simulation. */
export default function GoalieAvailability({ goalies, current }: { goalies: GoalieOption[]; current: NhlGoalieUnavailable[] }) {
  const router = useRouter();
  const [pick, setPick] = useState("");
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    const g = goalies.find((x) => String(x.id) === pick);
    if (!g) return setMessage("Pick a goalie first.");
    start(async () => {
      const r = await ruleOutGoalie(g.id, g.name, g.team, note, until || null);
      setMessage(r.message);
      if (r.ok) {
        setPick("");
        setNote("");
        setUntil("");
        router.refresh();
      }
    });
  };

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Goalies ruled out</h2>
      <p className="mb-3 max-w-3xl text-xs text-muted">
        If you know a goalie can&apos;t play - out for the season, or for a while - mark him here and the model stops counting on him anywhere: his team&apos;s starter
        probabilities, the lock-in lists, and the season simulation all use the remaining goalies instead. ESPN&apos;s injured reserve is already honoured
        automatically; this is for news ESPN hasn&apos;t caught up with.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Goalie
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${inputCls} w-56`}>
            <option value="">Select…</option>
            {goalies.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.team ? ` (${g.team})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Out until (blank = rest of season)
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={`${inputCls} w-40`} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. season-ending surgery" className={`${inputCls} w-56`} />
        </label>
        <button disabled={pending} onClick={submit} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50">
          {pending ? "Saving…" : "Rule out"}
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-muted">{message}</p>}

      {current.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
          {current.map((r) => (
            <li key={r.goalie_id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-foreground">
                {r.name ?? r.goalie_id}
                {r.team && <span className="ml-1 text-muted">({r.team})</span>}
                <span className="ml-2 text-warn">{r.until ? `out until ${r.until}` : "out for the season"}</span>
                {r.note && <span className="ml-2 text-muted">- {r.note}</span>}
              </span>
              <button
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await reinstateGoalie(r.goalie_id);
                    setMessage(res.message);
                    router.refresh();
                  })
                }
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50"
              >
                Reinstate
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
