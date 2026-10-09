"use client";

import { useState } from "react";

const SHOW = 8; // goals 0..7 on each axis - everything past that is a rounding error in the tails

function cellText(p: number): string {
  if (p >= 0.0995) return (p * 100).toFixed(1);
  if (p >= 0.001) return (p * 100).toFixed(1);
  return "";
}

/** Probability of every score as a heatmap: columns are the home team's goals, rows the away team's.
 * "Final" is the official score, where a shootout/overtime winner is credited a goal (so a tie never
 * appears and 4-3 can come from a 3-3 game); "Regulation" is the score at 60:00, where ties sit on the
 * diagonal. Home-win cells are tinted with the accent color, away-win cells with the warning color,
 * regulation ties muted - never green/red, which this app reserves for profit and loss. */
export default function ScoreGrid({ home, away, finalGrid, regGrid }: { home: string; away: string; finalGrid: number[][]; regGrid: number[][] }) {
  const [mode, setMode] = useState<"final" | "reg">("final");
  const grid = mode === "final" ? finalGrid : regGrid;
  const cells = grid.slice(0, SHOW).flatMap((row) => row.slice(0, SHOW));
  const max = Math.max(...cells, 1e-9);
  const shown = cells.reduce((s, p) => s + p, 0);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex w-fit gap-1 rounded-lg border border-border bg-surface p-1">
          {(
            [
              ["final", "Final score (incl. OT/SO credit)"],
              ["reg", "After 60:00"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${mode === key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--accent)" }} />
            {home} wins
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--warn)" }} />
            {away} wins
          </span>
          {mode === "reg" && (
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--muted)" }} />
              tied → OT/SO
            </span>
          )}
        </div>
      </div>

      <p className="mb-1.5 text-[11px] text-muted">
        Columns: <span className="text-foreground">{home}</span> goals (home) · Rows: <span className="text-foreground">{away}</span> goals (away)
      </p>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-0.5 text-center font-mono text-[11px]">
          <thead>
            <tr>
              <th />
              {Array.from({ length: SHOW }, (_, h) => (
                <th key={h} className="w-11 pb-1 text-xs font-semibold text-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: SHOW }, (_, a) => (
              <tr key={a}>
                <th className="pr-2 text-right text-xs font-semibold text-foreground">{a}</th>
                {Array.from({ length: SHOW }, (_, h) => {
                  const p = grid[h]?.[a] ?? 0;
                  const tone = h > a ? "var(--accent)" : h < a ? "var(--warn)" : "var(--muted)";
                  const strength = Math.round((p / max) * 80);
                  return (
                    <td
                      key={h}
                      title={`${home} ${h} – ${away} ${a}: ${(p * 100).toFixed(2)}%`}
                      className="h-9 w-11 rounded text-foreground"
                      style={{ background: p > 0.0005 ? `color-mix(in srgb, ${tone} ${strength}%, transparent)` : "transparent" }}
                    >
                      {cellText(p)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Cells are % chance of that exact score. Grid covers 0–7 goals each ({(shown * 100).toFixed(1)}% of all outcomes).
        {mode === "final" && " A game tied after 60:00 ends one goal apart on the official score, so the diagonal is empty."}
      </p>
    </div>
  );
}
