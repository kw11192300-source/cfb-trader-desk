"use client";

import { useMemo, useRef, useState } from "react";
import { americanToProb, fmtOdds, marginCover, overUnder } from "@/lib/nhlModel";
import { nhlLogoUrl } from "@/lib/nhlTeams";
import type { NhlMarket, NhlModelDigest, NhlOddsSnapshot } from "@/lib/types";

const W = 760;
const H = 270;
const PAD_L = 84; // y-axis labels + the team logos at the start of each line
const PAD_R = 54; // room for the latest price printed at the end of each line
const PAD_T = 46; // room for the model-change labels
const PAD_B = 30;

type Tab = "ml" | "pl" | "total";
type Frame = {
  t: number;
  isOpen: boolean;
  a: number | null; // away (moneyline / puck line) or over (total) American price
  b: number | null; // home or under
  line: number | null; // puck line = HOME's handicap; total = the total
  note: string | null;
  model: NhlModelDigest | null; // the model in force at this moment (carried forward)
  at: string | null;
};

const OVER_COLOR = "#a78bfa";
const UNDER_COLOR = "#f59e0b";
const TICKS = [-500, -400, -300, -250, -200, -175, -150, -130, -120, -110, 100, 110, 120, 130, 150, 175, 200, 250, 300, 400, 500];

/** Our probability for each side at a given line, from the model state in force then (pushes taken out). */
function modelSides(m: NhlModelDigest, tab: Tab, line: number | null): [number, number] | null {
  if (tab === "ml") return [1 - m.p_home, m.p_home];
  if (line === null) return null;
  if (tab === "pl") {
    const h = marginCover(m.margin_dist, "home", line);
    const a = marginCover(m.margin_dist, "away", -line);
    return [a.push < 1 ? a.win / (1 - a.push) : 0.5, h.push < 1 ? h.win / (1 - h.push) : 0.5];
  }
  const { over, under } = overUnder(m.total_dist, line);
  const live = over + under;
  return live > 0 ? [over / live, under / live] : null;
}

const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** DraftKings' price history for one game: both sides' real American prices (vig included) from the open to now, one line
 * per side in team colors, with our own fair price for each side dotted. Model changes (a goalie set, a re-run) are marked
 * across the top with what changed. Hover any point for its time stamp. */
export default function NhlOddsChart({
  snapshots,
  open,
  home,
  away,
  homeColor,
  awayColor,
  model,
}: {
  snapshots: NhlOddsSnapshot[];
  open: NhlMarket | null;
  home: string;
  away: string;
  homeColor: string;
  awayColor: string;
  model: { p_home: number; margin_dist: Record<string, number>; total_dist: Record<string, number> };
}) {
  const [tab, setTab] = useState<Tab>("ml");
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nick = (t: string) => t.split(" ").slice(-1)[0];
  const awayLogo = nhlLogoUrl(away);
  const homeLogo = nhlLogoUrl(home);

  const fallbackModel: NhlModelDigest = useMemo(
    () => ({ generated_at: "", p_home: model.p_home, margin_dist: model.margin_dist, total_dist: model.total_dist, goalies: { home: [], away: [] }, confirmed: { home: false, away: false }, sources: { home: "", away: "" } }),
    [model],
  );

  const frames: Frame[] = useMemo(() => {
    const sorted = [...snapshots].sort((x, y) => new Date(x.captured_at).getTime() - new Date(y.captured_at).getTime());
    // the model in force before the first saved model state is that first state (nothing earlier is known)
    const firstModel = sorted.find((s) => s.model)?.model ?? fallbackModel;
    let carried: NhlModelDigest = firstModel;
    const out: Frame[] = [];
    for (const s of sorted) {
      if (s.model) carried = s.model;
      const t = new Date(s.captured_at).getTime();
      const base = { t, isOpen: false, note: s.model_note, model: carried, at: s.captured_at };
      if (tab === "ml") out.push({ ...base, a: s.ml_away, b: s.ml_home, line: null });
      else if (tab === "pl") out.push({ ...base, a: s.spread_away_odds, b: s.spread_home_odds, line: s.spread_home_line });
      else out.push({ ...base, a: s.over_odds, b: s.under_odds, line: s.total_line });
    }
    const valid = out.filter((f) => f.a !== null && f.b !== null);
    // the opening line goes at the left, ahead of the first saved snapshot (ESPN doesn't say when it was posted)
    if (open) {
      const t0 = valid.length > 0 ? valid[0].t : new Date(open.fetched_at ?? 0).getTime();
      const span = valid.length > 1 ? valid[valid.length - 1].t - valid[0].t : 0;
      const gap = Math.max(span * 0.06, 25 * 60 * 1000);
      const o: Frame =
        tab === "ml"
          ? { t: t0 - gap, isOpen: true, a: open.ml_away_open ?? null, b: open.ml_home_open ?? null, line: null, note: null, model: firstModel, at: null }
          : tab === "pl"
            ? { t: t0 - gap, isOpen: true, a: open.spread_away_odds_open ?? null, b: open.spread_home_odds_open ?? null, line: open.spread_home_line_open ?? null, note: null, model: firstModel, at: null }
            : { t: t0 - gap, isOpen: true, a: open.over_odds_open ?? null, b: open.under_odds_open ?? null, line: open.total_line_open ?? null, note: null, model: firstModel, at: null };
      if (o.a !== null && o.b !== null) valid.unshift(o);
    }
    return valid;
  }, [snapshots, open, tab, fallbackModel]);

  const names = tab === "total" ? { a: "Over", b: "Under" } : { a: nick(away), b: nick(home) };
  const colors = tab === "total" ? { a: OVER_COLOR, b: UNDER_COLOR } : { a: awayColor, b: homeColor };

  const body = (() => {
    if (frames.length === 0) return <p className="text-xs text-muted">No price history for this market yet.</p>;
    const tMin = frames[0].t;
    const tMax = Math.max(frames[frames.length - 1].t, tMin + 60000);
    // y is the implied probability of the price (vig included) so the American scale is continuous across +100/-100
    // Once the posted number (puck line / total) moves, the model line stops: the new number is a different bet, and the
    // current one is priced in the Model vs DraftKings table above. (Moneyline has no number, so it runs the whole way.)
    const movedAt = tab === "ml" ? -1 : frames.findIndex((f, i) => i > 0 && f.line !== frames[0].line);
    const showModel = (i: number) => movedAt === -1 || i < movedAt;

    const ys: number[] = [];
    frames.forEach((f, i) => {
      ys.push(americanToProb(f.a!), americanToProb(f.b!));
      const m = showModel(i) ? modelSides(f.model!, tab, f.line) : null;
      if (m) ys.push(m[0], m[1]);
    });
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const pad = Math.max((hi - lo) * 0.18, 0.02);
    const yMin = lo - pad;
    const yMax = hi + pad;
    const x = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * (W - PAD_L - PAD_R);
    const y = (p: number) => PAD_T + (1 - (p - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B);

    // stepped path that breaks wherever the posted number (puck line / total) changes
    const stepPath = (vals: (number | null)[]) => {
      let d = "";
      frames.forEach((f, i) => {
        const v = vals[i];
        if (v === null) return;
        const brk = i === 0 || f.line !== frames[i - 1].line || vals[i - 1] === null;
        if (brk) d += `M${x(f.t).toFixed(1)},${y(v).toFixed(1)} `;
        else d += `L${x(f.t).toFixed(1)},${y(vals[i - 1]!).toFixed(1)} L${x(f.t).toFixed(1)},${y(v).toFixed(1)} `;
        // hold the price until the next saved change (or the right edge); a segment never runs past a move of the number
        const next = frames[i + 1];
        const endT = next ? (next.line === f.line ? null : next.t) : tMax;
        if (endT !== null) d += `L${x(endT).toFixed(1)},${y(v).toFixed(1)} `;
      });
      return d.trim();
    };
    const aVals = frames.map((f) => americanToProb(f.a!));
    const bVals = frames.map((f) => americanToProb(f.b!));
    const mVals = frames.map((f, i) => (showModel(i) ? modelSides(f.model!, tab, f.line) : null));
    const mA = mVals.map((m) => (m ? m[0] : null));
    const mB = mVals.map((m) => (m ? m[1] : null));

    // American-price tick labels, thinned to a handful
    let ticks = TICKS.filter((o) => {
      const p = americanToProb(o);
      return p >= yMin && p <= yMax;
    });
    while (ticks.length > 6) ticks = ticks.filter((_, i) => i % 2 === 0);

    const noted = frames.map((f, i) => ({ f, i })).filter(({ f }) => f.note);
    const breaks = frames.map((f, i) => ({ f, i })).filter(({ f, i }) => i > 0 && f.line !== frames[i - 1].line && f.line !== null);
    const first = frames[0];
    const last = frames[frames.length - 1];
    const fmtFull = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const fmtShort = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return;
      const px = ((e.clientX - r.left) / r.width) * W;
      let best = 0;
      let bd = Infinity;
      frames.forEach((f, i) => {
        const d = Math.abs(x(f.t) - px);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      setHover(best);
    };
    const hf = hover !== null && hover < frames.length ? frames[hover] : null;
    const lineLabel = (f: Frame) => (f.line === null ? "" : tab === "pl" ? `${nick(home)} ${fmtLine(f.line)}` : `total ${f.line}`);

    const logo = (src: string | null, cy: number, fallback: string, color: string) =>
      src ? (
        <image href={src} x={PAD_L - 30} y={cy - 11} width={22} height={22} />
      ) : (
        <g>
          <circle cx={PAD_L - 19} cy={cy} r={10} fill={color} />
          <text x={PAD_L - 19} y={cy + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#0b0f14">
            {fallback}
          </text>
        </g>
      );

    return (
      <div>
        <div className="relative">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="DraftKings price history" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map((o) => (
              <g key={o}>
                <line x1={PAD_L} x2={W - PAD_R} y1={y(americanToProb(o))} y2={y(americanToProb(o))} stroke="var(--border)" strokeWidth={1} />
                <text x={PAD_L - 36} y={y(americanToProb(o)) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
                  {fmtOdds(o)}
                </text>
              </g>
            ))}

            {/* model changes: a dashed marker with what changed, staggered so labels don't collide */}
            {noted.map(({ f, i }, k) => (
              <g key={`m${i}`}>
                <line x1={x(f.t)} x2={x(f.t)} y1={PAD_T - 4} y2={H - PAD_B} stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 3" />
                <text
                  x={Math.min(x(f.t) + 4, W - PAD_R - 4)}
                  y={12 + (k % 3) * 11}
                  textAnchor={x(f.t) > W - 260 ? "end" : "start"}
                  dx={x(f.t) > W - 260 ? -8 : 0}
                  fontSize={9.5}
                  fill="var(--foreground)"
                >
                  {f.note!.length > 46 ? `${f.note!.slice(0, 45)}…` : f.note}
                </text>
              </g>
            ))}

            {/* the posted number changed (puck line / total): a divider and what it moved to */}
            {breaks.map(({ f, i }) => (
              <g key={`b${i}`}>
                <line x1={x(f.t)} x2={x(f.t)} y1={PAD_T} y2={H - PAD_B} stroke="var(--border)" strokeWidth={1.5} />
                <text x={x(f.t) + 4} y={H - PAD_B - 5} fontSize={9.5} fill="var(--muted)">
                  {lineLabel(f)}
                </text>
              </g>
            ))}
            {first.line !== null && (
              <text x={PAD_L + 4} y={H - PAD_B - 5} fontSize={9.5} fill="var(--muted)">
                {lineLabel(first)}
              </text>
            )}

            {/* our fair prices, dotted in each side's color */}
            <path d={stepPath(mA)} fill="none" stroke={colors.a} strokeWidth={1.6} strokeDasharray="2 4" strokeLinecap="round" opacity={0.9} />
            <path d={stepPath(mB)} fill="none" stroke={colors.b} strokeWidth={1.6} strokeDasharray="2 4" strokeLinecap="round" opacity={0.9} />

            {/* DraftKings' actual prices */}
            <path d={stepPath(aVals)} fill="none" stroke={colors.a} strokeWidth={2.4} />
            <path d={stepPath(bVals)} fill="none" stroke={colors.b} strokeWidth={2.4} />
            {frames.map((f, i) => (
              <g key={`p${i}`}>
                <circle cx={x(f.t)} cy={y(aVals[i])} r={hover === i ? 5 : 3.2} fill={colors.a} stroke={f.isOpen ? "var(--foreground)" : "none"} strokeWidth={1} />
                <circle cx={x(f.t)} cy={y(bVals[i])} r={hover === i ? 5 : 3.2} fill={colors.b} stroke={f.isOpen ? "var(--foreground)" : "none"} strokeWidth={1} />
              </g>
            ))}
            {hf && <line x1={x(hf.t)} x2={x(hf.t)} y1={PAD_T} y2={H - PAD_B} stroke="var(--foreground)" strokeWidth={1} opacity={0.25} />}

            {/* team logos (or O/U chips) at the start of each line, latest price at the end */}
            {tab === "total" ? (
              <>
                {logo(null, y(aVals[0]), "O", colors.a)}
                {logo(null, y(bVals[0]), "U", colors.b)}
              </>
            ) : (
              <>
                {logo(awayLogo, y(aVals[0]), nick(away)[0], colors.a)}
                {logo(homeLogo, y(bVals[0]), nick(home)[0], colors.b)}
              </>
            )}
            <text x={W - PAD_R + 6} y={y(aVals[aVals.length - 1]) + 3.5} fontSize={11} fontWeight={700} fill={colors.a}>
              {fmtOdds(last.a)}
            </text>
            <text x={W - PAD_R + 6} y={y(bVals[bVals.length - 1]) + 3.5} fontSize={11} fontWeight={700} fill={colors.b}>
              {fmtOdds(last.b)}
            </text>

            <text x={PAD_L} y={H - 8} fontSize={10} fill="var(--muted)">
              {first.isOpen ? "open" : fmtShort(first.t)}
            </text>
            <text x={W - PAD_R} y={H - 8} textAnchor="end" fontSize={10} fill="var(--muted)">
              {frames.length > 1 ? fmtShort(last.t) : "no price change saved yet"}
            </text>
          </svg>

          {hf && (
            <div
              className="pointer-events-none absolute z-10 w-60 rounded-md border border-border bg-surface-raised px-3 py-2 text-[11px] shadow-card"
              style={{ left: `${Math.min(Math.max((x(hf.t) / W) * 100, 12), 78)}%`, top: 6, transform: "translateX(-50%)" }}
            >
              <div className="font-semibold text-foreground">{hf.isOpen ? "Opening line" : fmtFull(hf.t)}</div>
              {hf.isOpen && <div className="text-muted">time it was posted isn&apos;t recorded</div>}
              {hf.line !== null && <div className="text-muted">{lineLabel(hf)}</div>}
              <div className="mt-1 flex justify-between gap-3 font-mono">
                <span style={{ color: colors.a }}>
                  {names.a} {fmtOdds(hf.a)}
                </span>
                <span style={{ color: colors.b }}>
                  {names.b} {fmtOdds(hf.b)}
                </span>
              </div>
              {hf.note && <div className="mt-1 text-foreground">Model: {hf.note}</div>}
            </div>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: colors.a }} />
              {names.a}
              <span className="font-mono text-foreground">
                {fmtOdds(first.a)} → {fmtOdds(last.a)}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: colors.b }} />
              {names.b}
              <span className="font-mono text-foreground">
                {fmtOdds(first.b)} → {fmtOdds(last.b)}
              </span>
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dotted" style={{ borderColor: "var(--foreground)" }} />
            our fair price (no vig)
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted">
          Solid = DraftKings&apos; actual price (vig included), open → latest. Dotted = our price for the same side
          {tab !== "ml" ? (movedAt === -1 ? ", at the posted number" : ", at the opening number (it stops when the number moves - see Model vs DraftKings above for the current one)") : ""}.
          {breaks.length > 0 &&
            ` The ${tab === "pl" ? "puck line" : "total"} moved ${breaks.length} time${breaks.length === 1 ? "" : "s"}, so the lines break at each move - a price on a different number isn't comparable.`}
        </p>
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
            onClick={() => {
              setTab(key);
              setHover(null);
            }}
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
