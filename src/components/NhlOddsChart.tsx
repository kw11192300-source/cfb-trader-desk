"use client";

import { useMemo, useState } from "react";
import { devig, fmtOdds, marginCover, overUnder, pct } from "@/lib/nhlModel";
import type { NhlOddsSnapshot } from "@/lib/types";

const W = 640;
const H = 190;
const PAD_L = 40;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 26;

type Tab = "ml" | "pl" | "total";

type Pt = { t: number; v: number; tip: string; line: number | null };

/** DraftKings' price history for one game. Prices are plotted as the no-vig probability of the home side (moneyline and
 * puck line) or the over (total), so a move reads the same way whatever the American price crosses - and our own
 * probability for the same bet is drawn as a dashed line to hold the market against. */
export default function NhlOddsChart({
  snapshots,
  home,
  away,
  model,
}: {
  snapshots: NhlOddsSnapshot[];
  home: string;
  away: string;
  model: { p_home: number; margin_dist: Record<string, number>; total_dist: Record<string, number> };
}) {
  const [tab, setTab] = useState<Tab>("ml");
  const nick = (t: string) => t.split(" ").slice(-1)[0];

  const { points, modelP, label, last } = useMemo(() => {
    const pts: Pt[] = [];
    let lastLine: number | null = null;
    let lastText = "";
    for (const s of snapshots) {
      const t = new Date(s.captured_at).getTime();
      if (tab === "ml" && s.ml_home !== null && s.ml_away !== null) {
        pts.push({ t, v: devig(s.ml_home, s.ml_away), line: null, tip: `${nick(away)} ${fmtOdds(s.ml_away)} / ${nick(home)} ${fmtOdds(s.ml_home)}` });
        lastText = `${nick(away)} ${fmtOdds(s.ml_away)} · ${nick(home)} ${fmtOdds(s.ml_home)}`;
      } else if (tab === "pl" && s.spread_home_line !== null && s.spread_home_odds !== null && s.spread_away_odds !== null) {
        const L = s.spread_home_line;
        pts.push({ t, v: devig(s.spread_home_odds, s.spread_away_odds), line: L, tip: `${nick(home)} ${L > 0 ? "+" : ""}${L} ${fmtOdds(s.spread_home_odds)} / ${nick(away)} ${fmtOdds(s.spread_away_odds)}` });
        lastLine = L;
        lastText = `${nick(home)} ${L > 0 ? "+" : ""}${L} ${fmtOdds(s.spread_home_odds)} · ${nick(away)} ${fmtOdds(s.spread_away_odds)}`;
      } else if (tab === "total" && s.total_line !== null && s.over_odds !== null && s.under_odds !== null) {
        pts.push({ t, v: devig(s.over_odds, s.under_odds), line: s.total_line, tip: `${s.total_line}: over ${fmtOdds(s.over_odds)} / under ${fmtOdds(s.under_odds)}` });
        lastLine = s.total_line;
        lastText = `${s.total_line}: over ${fmtOdds(s.over_odds)} · under ${fmtOdds(s.under_odds)}`;
      }
    }
    let p: number | null = null;
    if (tab === "ml") p = model.p_home;
    else if (tab === "pl" && lastLine !== null) {
      const { win, push } = marginCover(model.margin_dist, "home", lastLine);
      p = push < 1 ? win / (1 - push) : null;
    } else if (tab === "total" && lastLine !== null) {
      const { over, under } = overUnder(model.total_dist, lastLine);
      p = over + under > 0 ? over / (over + under) : null;
    }
    const names = { ml: `${nick(home)} win`, pl: `${nick(home)} cover`, total: "Over" };
    return { points: pts, modelP: p, label: names[tab], last: lastText };
  }, [snapshots, tab, home, away, model]);

  const body = (() => {
    if (points.length === 0) return <p className="text-xs text-muted">No price history for this market yet.</p>;
    const ts = points.map((p) => p.t);
    const tMin = Math.min(...ts);
    const tMax = Math.max(...ts, tMin + 1);
    const vals = points.map((p) => p.v).concat(modelP !== null ? [modelP] : []);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.25, 0.01);
    const yMin = lo - pad;
    const yMax = hi + pad;
    const x = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * (W - PAD_L - PAD_R);
    const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B);
    // hold each price until the next change, so a flat stretch reads as "no movement" instead of an interpolated slope
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(i > 0 ? points[i - 1].v : p.v).toFixed(1)} L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const tail = `L${x(tMax).toFixed(1)},${y(points[points.length - 1].v).toFixed(1)}`;
    const ticks = [yMin + pad * 0.4, (yMin + yMax) / 2, yMax - pad * 0.4];
    const fmtT = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const lineChanges = points.filter((p, i) => i > 0 && p.line !== null && p.line !== points[i - 1].line);
    return (
      <div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="DraftKings price history">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD_L - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
                {pct(v, 1)}
              </text>
            </g>
          ))}
          {modelP !== null && (
            <g>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(modelP)} y2={y(modelP)} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="5 4" />
              <text x={W - PAD_R} y={y(modelP) - 4} textAnchor="end" fontSize={10} fill="var(--accent)">
                model {pct(modelP, 1)}
              </text>
            </g>
          )}
          <path d={`${path} ${tail}`} fill="none" stroke="#4ade80" strokeWidth={2} />
          {points.map((p) => (
            <circle key={p.t} cx={x(p.t)} cy={y(p.v)} r={3} fill="#4ade80">
              <title>{`${fmtT(p.t)} - ${p.tip} (no-vig ${pct(p.v, 1)})`}</title>
            </circle>
          ))}
          <text x={PAD_L} y={H - 8} fontSize={10} fill="var(--muted)">
            {fmtT(tMin)}
          </text>
          <text x={W - PAD_R} y={H - 8} textAnchor="end" fontSize={10} fill="var(--muted)">
            {points.length > 1 ? fmtT(tMax) : "only one snapshot so far"}
          </text>
        </svg>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted">
          <span>
            <span className="text-foreground">Now:</span> <span className="font-mono text-up">{last}</span>
          </span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: "#4ade80" }} />
              DK no-vig {label.toLowerCase()}
            </span>
            {modelP !== null && (
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: "var(--accent)" }} />
                model
              </span>
            )}
          </span>
        </div>
        {lineChanges.length > 0 && (
          <p className="mt-1 text-[11px] text-muted">
            The line moved {lineChanges.length} time{lineChanges.length === 1 ? "" : "s"}: {points[0].line} → {lineChanges.map((p) => p.line).join(" → ")}. The dashed model line is for the latest line.
          </p>
        )}
      </div>
    );
  })();

  return (
    <div>
      <div className="mb-3 flex w-fit gap-1 rounded-lg border border-border bg-surface p-1">
        {(
          [
            ["ml", "Moneyline"],
            ["pl", "Puck line"],
            ["total", "Total"],
          ] as const
        ).map(([key, name]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${tab === key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
          >
            {name}
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}
