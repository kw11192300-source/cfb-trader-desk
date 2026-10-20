"use client";

import { useState } from "react";
import type { NbaGameProjection, NbaPlayerProjection, NbaStatDist } from "@/lib/data";
import { nbaShort } from "@/lib/nbaTeams";

const STATS: [string, string][] = [
  ["pts", "Pts"], ["reb", "Reb"], ["ast", "Ast"], ["tpm", "3PM"], ["pra", "PRA"], ["pr", "P+R"], ["pa", "P+A"], ["ra", "R+A"], ["stocks", "Stl+Blk"], ["stl", "Stl"], ["blk", "Blk"], ["tov", "TO"],
];
const ET = "America/New_York";
const sp = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n > 0 ? `+${n}` : `${n}`);

/** P(stat >= k) from the stored distribution (ge[i] = P(stat >= k0 + i)); outside the stored range it is ~1 below and ~0 above. */
function geAt(d: NbaStatDist, k: number): number {
  if (k < d.k0) return 0.99;
  const i = k - d.k0;
  return i < d.ge.length ? d.ge[i] : 0.01;
}
function odds(d: NbaStatDist, line: number): { over: number; under: number; push: number } {
  if (line % 1 !== 0) {
    const over = geAt(d, Math.ceil(line));
    return { over, under: 1 - over, push: 0 };
  }
  const over = geAt(d, line + 1);
  const atLeast = geAt(d, line);
  return { over, under: 1 - atLeast, push: Math.max(atLeast - over, 0) };
}

/** What the injury report is worth to the spread (fresh news only) compared with how far the line has moved, plus every player's
 * projected minutes and stat range for the game. Projections come from the live job (python/nba_model/live_run.py) and follow the
 * official injury report; a Questionable player is a blend of him playing and sitting. */
export default function NbaProjectionPanel({ proj, players, homeTeam, awayTeam }: { proj: NbaGameProjection | undefined; players: NbaPlayerProjection[]; homeTeam: string; awayTeam: string }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"home" | "away">("home");
  const [stat, setStat] = useState("pts");
  const [lines, setLines] = useState<Record<number, string>>({});
  if (!proj && players.length === 0) return null;

  const homeShort = nbaShort(homeTeam);
  const awayShort = nbaShort(awayTeam);
  const nm = proj?.news_move ?? null;
  const gap = proj?.gap ?? null;
  const stale = nm !== null && gap !== null && Math.abs(gap) >= 1 && Math.abs(nm) >= 0.75;
  const leanHome = (gap ?? 0) > 0;
  const lineNow = proj?.line_now ?? null;
  const contrib = proj?.detail?.contrib;
  const updated = proj ? new Date(proj.computed_at).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" }) : null;
  const mine = players.filter((p) => p.side === side);
  const noHistory = mine.filter((p) => (p.n_prior ?? 0) === 0 && (p.exp_min ?? 0) >= 5).length;

  return (
    <div className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-snug">
      {proj && (
        <div>
          {proj.pending_home && proj.pending_away ? (
            <span className="text-muted">Injury report not in yet - projections assume full rosters.</span>
          ) : (
            <>
              <span className="text-muted">Injury news: </span>
              {nm === null || Math.abs(nm) < 0.3 ? (
                <span className="text-foreground">nothing new to price</span>
              ) : (
                <span className="font-medium text-foreground">
                  {Math.abs(nm).toFixed(1)} pts toward {nm > 0 ? homeShort : awayShort}
                </span>
              )}
              {proj.moved !== null && (
                <span className="text-muted">
                  {" "}
                  · line has moved {Math.abs(proj.moved).toFixed(1)}
                  {proj.moved !== 0 ? ` toward ${proj.moved > 0 ? homeShort : awayShort}` : ""} since we first saw it
                </span>
              )}
            </>
          )}
          {stale && (
            <div className="mt-1 rounded border border-warn/50 bg-warn/10 px-2 py-1 text-warn">
              Line may be stale: the news favours {leanHome ? homeShort : awayShort} by about {Math.abs(gap ?? 0).toFixed(1)} more than the line has moved
              {lineNow !== null && (
                <>
                  {" "}
                  - lean {leanHome ? `${homeShort} ${sp(lineNow)}` : `${awayShort} ${sp(-lineNow)}`}. <span className="text-muted">Unproven signal; track the closing line.</span>
                </>
              )}
            </div>
          )}
          {contrib && (contrib.home.length > 0 || contrib.away.length > 0) && (
            <div className="mt-1 text-muted">
              {[...contrib.away.map((c) => ({ ...c, t: awayShort })), ...contrib.home.map((c) => ({ ...c, t: homeShort }))]
                .slice(0, 6)
                .map((c) => `${c.name ?? "?"} (${c.t}, ${Math.round(c.p_play * 100)}% to play, ${c.effect > 0 ? "+" : ""}${c.effect.toFixed(1)} for his team)`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      {players.length > 0 && (
        <div className="mt-1.5">
          <button onClick={() => setOpen(!open)} className="text-accent hover:underline">
            {open ? "Hide" : "Show"} projected minutes &amp; stats
          </button>
          {updated && <span className="text-muted"> · updated {updated} ET</span>}
        </div>
      )}

      {open && (
        <div className="mt-2">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {(["away", "home"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`rounded border px-2 py-0.5 ${side === s ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`}
              >
                {s === "home" ? homeShort : awayShort}
              </button>
            ))}
            <span className="mx-1 text-muted">|</span>
            {STATS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setStat(k)}
                className={`rounded border px-1.5 py-0.5 ${stat === k ? "border-foreground text-foreground" : "border-border text-muted hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left">
              <thead className="text-muted">
                <tr>
                  <th className="py-0.5 pr-2 font-normal">Player</th>
                  <th className="py-0.5 pr-2 font-normal">Min</th>
                  <th className="py-0.5 pr-2 font-normal">{STATS.find(([k]) => k === stat)?.[1]} (median · avg)</th>
                  <th className="py-0.5 pr-2 font-normal">Line</th>
                  <th className="py-0.5 font-normal">Over / Under</th>
                </tr>
              </thead>
              <tbody>
                {mine.slice(0, 13).map((p) => {
                  const out = p.p_play <= 0.03;
                  const d = p.stats?.[stat];
                  const raw = lines[p.player_id];
                  const line = raw !== undefined && raw !== "" ? Number(raw) : NaN;
                  const o = d && Number.isFinite(line) ? odds(d, line) : null;
                  return (
                    <tr key={p.player_id} className="border-t border-border/40">
                      <td className="py-0.5 pr-2">
                        <span className={out ? "text-muted line-through" : "text-foreground"}>{p.name}</span>
                        {p.status && p.status !== "Available" && (
                          <span className={`ml-1 ${out ? "text-down" : "text-warn"}`}>
                            {p.status === "Out" ? "OUT" : `${p.status.slice(0, 1)} ${Math.round(p.p_play * 100)}%`}
                          </span>
                        )}
                        {(p.n_prior ?? 0) === 0 && !out && <span className="ml-1 text-muted">new</span>}
                      </td>
                      <td className="py-0.5 pr-2 font-mono">{out || p.min_mean === null ? "—" : `${p.min_mean.toFixed(0)} (${p.min_q10?.toFixed(0)}-${p.min_q90?.toFixed(0)})`}</td>
                      <td className="py-0.5 pr-2 font-mono">{d && !out ? `${d.median} · ${d.mean.toFixed(1)}` : "—"}</td>
                      <td className="py-0.5 pr-2">
                        {d && !out ? (
                          <input
                            inputMode="decimal"
                            value={raw ?? ""}
                            onChange={(e) => setLines({ ...lines, [p.player_id]: e.target.value })}
                            placeholder={`${d.median}.5`}
                            className="w-14 rounded border border-border bg-background px-1 py-0.5 font-mono text-foreground"
                          />
                        ) : null}
                      </td>
                      <td className="py-0.5 font-mono">
                        {o ? (
                          <>
                            <span className={o.over >= 0.55 ? "text-up" : ""}>{Math.round(o.over * 100)}%</span>
                            <span className="text-muted"> / </span>
                            <span className={o.under >= 0.55 ? "text-up" : ""}>{Math.round(o.under * 100)}%</span>
                            {o.push > 0.005 && <span className="text-muted"> (push {Math.round(o.push * 100)}%)</span>}
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-muted">
            Minutes and stats are the model&apos;s read for each player if he plays, blended over the in/out chances on the injury report; minutes of anyone out go to
            the next men up.{noHistory > 0 ? ` ${noHistory} player${noHistory === 1 ? "" : "s"} marked new have no NBA history, so their numbers are generic.` : ""} Type a book line to see the model&apos;s over / under chance; compare it with the price before betting.
          </p>
        </div>
      )}
    </div>
  );
}
