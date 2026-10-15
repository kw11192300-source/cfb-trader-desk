"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reinstateCbbPlayer, ruleOutCbbPlayer } from "@/lib/actions";
import { playerEffect, STATUS_P } from "@/lib/cbbAvailability";
import type { CbbAvailability } from "@/lib/types";

export type TeamOption = { id: number; name: string };
export type PlayerOption = { id: number; name: string; f: number; v: number; mpg: number | null; role: string | null };

const inputCls = "rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none";

/** Mark a player out / doubtful / questionable. The effect is applied by every board and game page immediately: a missing
 * rotation player is worth roughly 0.4 x (his share of the game x his rating) + 1.2 x his share, in points of margin. */
export default function CbbAvailabilityForm({
  season,
  teams,
  teamId,
  roster,
  current,
}: {
  season: number;
  teams: TeamOption[];
  teamId: number | null;
  roster: PlayerOption[];
  current: CbbAvailability[];
}) {
  const router = useRouter();
  const [pick, setPick] = useState("");
  const [status, setStatus] = useState("out");
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const team = teams.find((t) => t.id === teamId) ?? null;
  const chosen = roster.find((p) => String(p.id) === pick) ?? null;
  const preview = chosen ? playerEffect({ f: chosen.f, v: chosen.v, status }) : null;

  const submit = () => {
    if (!team || !chosen) return setMessage("Pick a team and a player first.");
    start(async () => {
      const r = await ruleOutCbbPlayer({
        season, teamId: team.id, team: team.name, playerId: chosen.id, playerName: chosen.name, status, f: chosen.f, v: chosen.v, note: note || null, until: until || null,
      });
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
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Rule a player out</h2>
        <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted">
          Mark a player who will miss games and every board and game page re-prices his team on the spot: our spread and total move, the win and cover probabilities
          follow, and the player shows under the game. Across 17,000 past games a missing rotation player cost his team about{" "}
          <span className="text-foreground">0.4 × (his share of the game × his rating) + 1.2 × his share</span> in points, and the opening line had priced only about a quarter
          of it. Doubtful, questionable and probable apply that effect at 75%, 50% and 15%.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Team
            <select value={teamId ?? ""} onChange={(e) => router.push(e.target.value ? `/cbb/availability?team=${e.target.value}` : "/cbb/availability")} className={`${inputCls} w-56`}>
              <option value="">Select a team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Player
            <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${inputCls} w-60`} disabled={!team}>
              <option value="">{team ? "Select…" : "Pick a team first"}</option>
              {roster.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.mpg !== null ? ` · ${p.mpg.toFixed(0)} mpg` : ""}
                  {` · ${p.v > 0 ? "+" : ""}${p.v.toFixed(1)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputCls} w-36`}>
              {Object.keys(STATUS_P).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Until (blank = until reinstated)
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={`${inputCls} w-40`} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. ankle, game-time decision" className={`${inputCls} w-56`} />
          </label>
          <button disabled={pending || !chosen} onClick={submit} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50">
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
        {preview && chosen && (
          <p className="mt-2 text-xs text-muted">
            Effect if saved: <span className="text-foreground">{team?.name} {preview.margin.toFixed(1)} points worse</span>, game total{" "}
            <span className="text-foreground">{preview.total.toFixed(1)}</span>.
          </p>
        )}
        {message && <p className="mt-2 text-xs text-muted">{message}</p>}
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Currently marked ({current.length})</h2>
        {current.length === 0 ? (
          <p className="text-xs text-muted">Nobody yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {current.map((r) => {
              const e = playerEffect(r);
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 py-1.5 text-xs last:border-0">
                  <span className="text-foreground">
                    {r.player_name}
                    {r.team && <span className="ml-1 text-muted">({r.team})</span>}
                    <span className="ml-2 text-warn">
                      {r.status}
                      {r.until ? ` until ${r.until}` : ""}
                    </span>
                    <span className="ml-2 font-mono text-muted">
                      -{e.margin.toFixed(1)} margin · {e.total.toFixed(1)} total
                    </span>
                    {r.note && <span className="ml-2 text-muted">- {r.note}</span>}
                  </span>
                  <button
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const res = await reinstateCbbPlayer(r.id);
                        setMessage(res.message);
                        router.refresh();
                      })
                    }
                    className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50"
                  >
                    Reinstate
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
