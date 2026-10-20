"use client";

import { useMemo, useState } from "react";
import type { NbaPlayerProjection } from "@/lib/data";
import { balanced, dist, ev, fairOdds, geAt, impliedProb, joint, MILESTONES, overUnder, STAT_LABEL, STAT_SHORT } from "@/lib/nbaProj";

const LINE_STATS = ["pts", "reb", "ast", "tpm", "pra", "pr", "pa", "ra", "stocks"];
const MILE_STATS = ["pts", "reb", "ast", "tpm", "stl", "blk", "pra"];
const pct = (p: number) => `${Math.round(p * 100)}%`;
const heat = (p: number) => (p >= 0.04 ? `rgba(80,160,255,${(Math.min(p, 1) * 0.55).toFixed(3)})` : undefined);

type Tab = "lines" | "milestones" | "checker";

/** Player prop tools for one game: the balanced line for every player and market (the line where the model says it is a coin flip),
 * milestone hit rates (chance of reaching 10 / 15 / 20 ... points etc., plus double- and triple-double), and a line checker that turns a
 * book's line and price into the model's over / under chance and expected value. All chances are for a player who plays - a prop on a
 * player who sits is void. */
export default function NbaPropsExplorer({ players, awayTeam, homeTeam }: { players: NbaPlayerProjection[]; awayTeam: string; homeTeam: string }) {
  const [tab, setTab] = useState<Tab>("lines");
  const [side, setSide] = useState<"away" | "home">("away");
  const [mstat, setMstat] = useState("pts");
  const live = useMemo(() => players.filter((p) => p.p_play > 0.03 && p.stats && (p.exp_min ?? 0) >= 4).sort((a, b) => (b.exp_min ?? 0) - (a.exp_min ?? 0)), [players]);
  const mine = live.filter((p) => p.side === side).slice(0, 12);

  // line checker state
  const [pid, setPid] = useState<number | "">("");
  const [cstat, setCstat] = useState("pts");
  const [cline, setCline] = useState("");
  const [oPrice, setOPrice] = useState("-110");
  const [uPrice, setUPrice] = useState("-110");
  const sel = live.find((p) => p.player_id === pid) ?? null;
  const sd = sel ? dist(sel, cstat) : undefined;
  const bal = sd ? balanced(sd) : null;
  const lineNum = cline === "" ? (bal?.line ?? NaN) : Number(cline);
  const res = sd && Number.isFinite(lineNum) ? overUnder(sd, lineNum) : null;
  const evOf = (p: number, price: string) => {
    const n = Number(price);
    return Number.isFinite(n) && n !== 0 && Math.abs(n) >= 100 ? ev(p, n) : null;
  };

  if (live.length === 0) return null;
  const tabBtn = (t: Tab, label: string) => (
    <button key={t} onClick={() => setTab(t)} className={`rounded-md border px-3 py-1 text-xs font-medium ${tab === t ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`}>
      {label}
    </button>
  );
  const sideBtns = (
    <div className="flex gap-1.5">
      {(["away", "home"] as const).map((s) => (
        <button key={s} onClick={() => setSide(s)} className={`rounded border px-2.5 py-0.5 text-xs ${side === s ? "border-foreground text-foreground" : "border-border text-muted hover:text-foreground"}`}>
          {s === "home" ? homeTeam : awayTeam}
        </button>
      ))}
    </div>
  );

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex gap-1.5">
          {tabBtn("lines", "Balanced lines")}
          {tabBtn("milestones", "Milestones")}
          {tabBtn("checker", "Line checker")}
        </div>
        {tab !== "checker" && sideBtns}
      </div>

      {tab === "lines" && (
        <div className="overflow-x-auto px-4 py-3">
          <p className="mb-2 text-[11px] text-muted">
            The balanced line is the half-point line where the model puts the over closest to 50%. Under each line: the over chance. A book line below it favours the over; above it, the under.
          </p>
          <table className="w-full min-w-[680px] text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-3 text-left font-medium">Player</th>
                {LINE_STATS.map((k) => (
                  <th key={k} className="px-2 py-1.5 text-center font-medium">
                    {STAT_SHORT[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mine.map((p) => (
                <tr key={p.player_id} className="border-t border-border/50">
                  <td className="whitespace-nowrap py-1.5 pr-3 font-medium text-foreground">
                    {p.name}
                    {p.p_play < 0.97 && <span className="ml-1.5 text-[10px] text-warn">{pct(p.p_play)} to play</span>}
                  </td>
                  {LINE_STATS.map((k) => {
                    const d = dist(p, k);
                    if (!d) return <td key={k} className="px-2 py-1.5 text-center text-muted">—</td>;
                    const b = balanced(d);
                    const lopsided = Math.abs(b.over - 0.5) > 0.15; // no half-point line gets near a coin flip (a very low-count stat)
                    return (
                      <td key={k} className="px-2 py-1.5 text-center">
                        <div className={`font-mono font-semibold ${lopsided ? "text-muted" : "text-foreground"}`}>{b.line.toFixed(1)}</div>
                        <div className="font-mono text-[10px] text-muted">O {pct(b.over)} · {fairOdds(b.over)}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "milestones" && (
        <div className="overflow-x-auto px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {MILE_STATS.map((k) => (
              <button key={k} onClick={() => setMstat(k)} className={`rounded border px-2 py-0.5 text-xs ${mstat === k ? "border-foreground text-foreground" : "border-border text-muted hover:text-foreground"}`}>
                {STAT_LABEL[k]}
              </button>
            ))}
          </div>
          <table className="w-full min-w-[560px] text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-3 text-left font-medium">Player</th>
                {MILESTONES[mstat].map((m) => (
                  <th key={m} className="px-2 py-1.5 text-center font-medium">
                    {m}+
                  </th>
                ))}
                <th className="px-2 py-1.5 text-center font-medium">Dbl-dbl</th>
                <th className="px-2 py-1.5 text-center font-medium">Trp-dbl</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((p) => {
                const d = dist(p, mstat);
                const j = joint(p);
                return (
                  <tr key={p.player_id} className="border-t border-border/50">
                    <td className="whitespace-nowrap py-1.5 pr-3 font-medium text-foreground">{p.name}</td>
                    {MILESTONES[mstat].map((m) => {
                      const v = d ? geAt(d, m) : null;
                      return (
                        <td key={m} className="px-2 py-1.5 text-center font-mono text-foreground" style={{ backgroundColor: v !== null ? heat(v) : undefined }} title={v !== null ? `fair ${fairOdds(v)}` : undefined}>
                          {v === null ? "—" : v < 0.01 ? "<1%" : v > 0.985 ? ">98%" : pct(v)}
                          {v !== null && v >= 0.01 && v <= 0.985 && <div className="text-[9px] font-normal text-muted">{fairOdds(v)}</div>}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 text-center font-mono text-foreground" style={{ backgroundColor: j ? heat(j.dd) : undefined }} title={j ? `fair ${fairOdds(j.dd)}` : undefined}>
                      {j ? (j.dd < 0.01 ? "<1%" : pct(j.dd)) : "—"}
                      {j && j.dd >= 0.01 && <div className="text-[9px] font-normal text-muted">{fairOdds(j.dd)}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-center font-mono text-foreground" style={{ backgroundColor: j ? heat(j.td * 2) : undefined }} title={j ? `fair ${fairOdds(j.td)}` : undefined}>
                      {j ? (j.td < 0.005 ? "<1%" : `${(j.td * 100).toFixed(j.td < 0.1 ? 1 : 0)}%`) : "—"}
                      {j && j.td >= 0.005 && <div className="text-[9px] font-normal text-muted">{fairOdds(j.td)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted">Hover a cell for the fair price. Double- and triple-double chances come from simulating points, rebounds, assists, steals and blocks together, so a big scoring night and a big rebounding night tend to arrive together.</p>
        </div>
      )}

      {tab === "checker" && (
        <div className="px-4 py-3 text-xs">
          <p className="mb-3 text-[11px] text-muted">Pick a player and market, type the book&apos;s line and prices, and see the model&apos;s chance and the expected value of each side.</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-muted">
              Player
              <select value={pid} onChange={(e) => { setPid(e.target.value === "" ? "" : Number(e.target.value)); setCline(""); }} className="rounded border border-border bg-background px-2 py-1 text-foreground">
                <option value="">Choose…</option>
                {[awayTeam, homeTeam].map((t) => (
                  <optgroup key={t} label={t}>
                    {live.filter((p) => p.team === t).map((p) => (
                      <option key={p.player_id} value={p.player_id}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Market
              <select value={cstat} onChange={(e) => { setCstat(e.target.value); setCline(""); }} className="rounded border border-border bg-background px-2 py-1 text-foreground">
                {LINE_STATS.concat(["stl", "blk", "tov"]).map((k) => (
                  <option key={k} value={k}>
                    {STAT_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Line
              <input inputMode="decimal" value={cline} onChange={(e) => setCline(e.target.value)} placeholder={bal ? bal.line.toFixed(1) : "24.5"} className="w-20 rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Over price
              <input inputMode="numeric" value={oPrice} onChange={(e) => setOPrice(e.target.value)} className="w-20 rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Under price
              <input inputMode="numeric" value={uPrice} onChange={(e) => setUPrice(e.target.value)} className="w-20 rounded border border-border bg-background px-2 py-1 font-mono text-foreground" />
            </label>
          </div>
          {sel && sd && res && (
            <div className="mt-4 grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
              {([["Over", res.over, oPrice], ["Under", res.under, uPrice]] as const).map(([label, p, price]) => {
                const e = evOf(p, price);
                const imp = Number.isFinite(Number(price)) && Math.abs(Number(price)) >= 100 ? impliedProb(Number(price)) : null;
                return (
                  <div key={label} className={`rounded-lg border px-4 py-3 ${e !== null && e > 0.02 ? "border-up/60 bg-up/10" : "border-border bg-surface-raised"}`}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-[11px] uppercase tracking-wide text-muted">
                        {label} {lineNum}
                      </span>
                      <span className="font-mono text-lg font-semibold text-foreground">{pct(p)}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted">
                      Fair price {fairOdds(p)}
                      {imp !== null && <> · book implies {pct(imp)}</>}
                    </div>
                    {e !== null && (
                      <div className={`mt-1 font-mono text-sm ${e > 0 ? "text-up" : "text-down"}`}>
                        EV {e > 0 ? "+" : ""}
                        {(e * 100).toFixed(1)}% per unit
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="text-[11px] text-muted sm:col-span-2">
                {sel.name}: model average {sd.mean.toFixed(1)}, median {sd.median}
                {res.push > 0.005 ? ` · push ${pct(res.push)}` : ""}. A positive EV is only worth acting on if you trust the projection for this player - check his status and minutes above.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
