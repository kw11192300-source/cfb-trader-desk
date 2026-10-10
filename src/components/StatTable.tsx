"use client";

import { useMemo, useState } from "react";
import Image from "next/image";

export type StatRow = { id: string | number; label: string; sub?: string; logo?: string | null; stats: Record<string, number | null> };

export type StatCol = {
  key: string;
  label: string;
  /** Hover text explaining the column. */
  title?: string;
  /** How to print the stat (default: one decimal). */
  fmt?: (row: StatRow) => string;
  /** Shade the cell by its sign and size (text stays white): green above zero, red below, deeper the further from zero. */
  signed?: boolean;
};

const HEAT_MAX = 32; // % of green/red mixed into the cell at the extremes

/** -1 (worst) .. +1 (best) per row for one signed column, scaled by a high percentile of |value| so one outlier doesn't wash
 * everyone else out. Empty for columns that aren't signed. */
function heatScores(rows: StatRow[], col: StatCol): Map<string | number, number> {
  const out = new Map<string | number, number>();
  if (!col.signed) return out;
  const vals = rows.map((r) => ({ id: r.id, v: r.stats[col.key] })).filter((x): x is { id: string | number; v: number } => x.v !== null && x.v !== undefined && !Number.isNaN(x.v));
  if (vals.length < 3) return out;
  const abs = vals.map((x) => Math.abs(x.v)).sort((a, b) => a - b);
  const scale = abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.9))] || abs[abs.length - 1] || 1;
  for (const x of vals) out.set(x.id, Math.max(-1, Math.min(1, x.v / scale)));
  return out;
}

function heatStyle(t: number | undefined): React.CSSProperties | undefined {
  if (t === undefined) return undefined;
  const amount = Math.abs(t) * HEAT_MAX;
  if (amount < 2) return undefined;
  return { backgroundColor: `color-mix(in srgb, var(${t > 0 ? "--up" : "--down"}) ${amount.toFixed(0)}%, transparent)` };
}

const d = (n: number | null | undefined, digits: number): string => (n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(digits));
export const fmtD = (key: string, digits: number) => (r: StatRow) => d(r.stats[key], digits);
export const fmtPct = (key: string) => (r: StatRow) => (r.stats[key] === null || r.stats[key] === undefined ? "—" : `${((r.stats[key] as number) * 100).toFixed(1)}%`);

/** A sortable, filterable stats table: click a header to sort (click again to flip), type to filter by name/team.
 * `minKey`/`minDefault` adds a "min games" box that hides small samples. */
export default function StatTable({
  rows,
  cols,
  nameHeader,
  defaultSort,
  defaultDir = "desc",
  minKey,
  minDefault = 0,
  minLabel = "Min GP",
  empty,
}: {
  rows: StatRow[];
  cols: StatCol[];
  nameHeader: string;
  defaultSort: string;
  defaultDir?: "asc" | "desc";
  minKey?: string;
  minDefault?: number;
  minLabel?: string;
  empty: string;
}) {
  const [sortKey, setSortKey] = useState(defaultSort);
  const [dir, setDir] = useState<"asc" | "desc">(defaultDir);
  const [query, setQuery] = useState("");
  const [min, setMin] = useState(minDefault);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => (q === "" || r.label.toLowerCase().includes(q) || (r.sub ?? "").toLowerCase().includes(q)) && (!minKey || (r.stats[minKey] ?? 0) >= min));
    const sign = dir === "desc" ? -1 : 1;
    return out.sort((a, b) => {
      const av = sortKey === "__name" ? null : a.stats[sortKey];
      const bv = sortKey === "__name" ? null : b.stats[sortKey];
      if (sortKey === "__name") return sign * a.label.localeCompare(b.label);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return sign * (av - bv);
    });
  }, [rows, query, sortKey, dir, min, minKey]);

  // shade against everyone who passes the min-games box (not just the rows the text filter leaves), so filtering doesn't rescale the colours
  const heat = useMemo(() => {
    const pool = rows.filter((r) => !minKey || (r.stats[minKey] ?? 0) >= min);
    return new Map(cols.filter((c) => c.signed).map((c) => [c.key, heatScores(pool, c)] as const));
  }, [rows, cols, min, minKey]);

  const clickHeader = (key: string) => {
    if (key === sortKey) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setSortKey(key);
      setDir(key === "__name" ? "asc" : "desc");
    }
  };
  const arrow = (key: string) => (key === sortKey ? (dir === "desc" ? " ▼" : " ▲") : "");

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="w-48 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {minKey && (
          <label className="flex items-center gap-2 text-xs text-muted">
            {minLabel}
            <input
              type="number"
              min={0}
              value={min}
              onChange={(e) => setMin(Math.max(0, Number(e.target.value) || 0))}
              className="w-16 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            />
          </label>
        )}
        <span className="text-xs text-muted">{shown.length} shown</span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">{empty}</div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="sticky top-0 left-0 z-20 w-8 bg-surface-raised px-2 py-2.5 text-right font-medium">#</th>
                <th
                  onClick={() => clickHeader("__name")}
                  className="sticky top-0 left-8 z-20 cursor-pointer whitespace-nowrap bg-surface-raised px-3 py-2.5 font-medium hover:text-foreground"
                >
                  {nameHeader}
                  {arrow("__name")}
                </th>
                {cols.map((c) => (
                  <th
                    key={c.key}
                    title={c.title}
                    onClick={() => clickHeader(c.key)}
                    className={`sticky top-0 z-10 cursor-pointer whitespace-nowrap border-l border-border bg-surface-raised px-3 py-2.5 text-right font-medium hover:text-foreground ${c.key === sortKey ? "text-foreground" : ""}`}
                  >
                    {c.label}
                    {arrow(c.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={r.id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                  <td className="sticky left-0 z-10 bg-background px-2 py-2 text-right font-mono text-xs text-muted">{i + 1}</td>
                  <td className="sticky left-8 z-10 whitespace-nowrap bg-background px-3 py-2 text-foreground">
                    <span className="flex items-center gap-2">
                      {r.logo !== undefined &&
                        (r.logo ? (
                          <Image src={r.logo} alt="" width={22} height={22} className="h-[22px] w-[22px] shrink-0 object-contain" unoptimized />
                        ) : (
                          <span className="inline-block h-[22px] w-[22px] shrink-0 rounded-full bg-surface-raised" />
                        ))}
                      {r.label}
                      {r.sub && <span className="text-[11px] text-muted">{r.sub}</span>}
                    </span>
                  </td>
                  {cols.map((c) => {
                    const v = r.stats[c.key];
                    return (
                      <td key={c.key} style={heatStyle(heat.get(c.key)?.get(r.id))} className={`border-l border-border px-3 py-2 text-right font-mono text-xs text-foreground`}>
                        {c.fmt ? c.fmt(r) : d(v, 1)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
