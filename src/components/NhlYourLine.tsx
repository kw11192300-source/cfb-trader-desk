"use client";

import { useState } from "react";
import { customEdge, type EdgeRow } from "@/lib/nhlEdges";
import { fairOdds, fmtOdds, pct } from "@/lib/nhlModel";

type Market = EdgeRow["market"];
type Side = "home" | "away" | "over" | "under";
type Entry = { id: number; book: string; row: EdgeRow };

const inputCls = "rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none";
const pts = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

/** Type in a price from any book and see our edge and EV on it. Nothing is saved - the list lives on this page only,
 * since a price goes stale quickly. */
export default function NhlYourLine({
  home,
  away,
  dists,
  defaults,
}: {
  home: string;
  away: string;
  dists: { p_home: number; margin_dist: Record<string, number>; total_dist: Record<string, number> };
  defaults: { homeSpread: number | null; total: number | null };
}) {
  const [market, setMarket] = useState<Market>("Moneyline");
  const [side, setSide] = useState<Side>("away");
  const [line, setLine] = useState("");
  const [odds, setOdds] = useState("");
  const [book, setBook] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pickMarket = (m: Market) => {
    setMarket(m);
    setSide(m === "Total" ? "over" : "away");
    setLine(m === "Total" ? String(defaults.total ?? 6.5) : m === "Puck line" ? String(defaults.homeSpread !== null ? -defaults.homeSpread : 1.5) : "");
    setError(null);
  };
  // a puck line is the SIDE's own handicap: switching sides flips the sign of the suggested line
  const pickSide = (s: Side) => {
    if (market === "Puck line" && s !== side && line.trim() !== "" && Number.isFinite(Number(line))) setLine(String(-Number(line)));
    setSide(s);
  };

  const add = () => {
    const o = Number(odds.replace("+", ""));
    if (!Number.isFinite(o) || Math.abs(o) < 100) return setError("Enter American odds like +110 or -125.");
    const l = Number(line);
    if (market !== "Moneyline" && (line.trim() === "" || !Number.isFinite(l))) return setError(market === "Total" ? "Enter the total, e.g. 6.5." : "Enter the handicap for this side, e.g. -1.5 or +1.5.");
    setError(null);
    const row = customEdge(dists, home, away, { market, side, line: market === "Moneyline" ? 0 : l, odds: o });
    setEntries((e) => [...e, { id: Date.now() + e.length, book: book.trim(), row }]);
    setOdds("");
  };

  const teamOptions = [
    { value: "away", label: away },
    { value: "home", label: home },
  ];

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Check another book&apos;s price</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Book (optional)
          <input value={book} onChange={(e) => setBook(e.target.value)} placeholder="e.g. Pinnacle" className={`${inputCls} w-28`} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Market
          <select value={market} onChange={(e) => pickMarket(e.target.value as Market)} className={inputCls}>
            <option>Moneyline</option>
            <option>Puck line</option>
            <option>Total</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Side
          <select value={side} onChange={(e) => pickSide(e.target.value as Side)} className={inputCls}>
            {market === "Total" ? (
              <>
                <option value="over">Over</option>
                <option value="under">Under</option>
              </>
            ) : (
              teamOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))
            )}
          </select>
        </label>
        {market !== "Moneyline" && (
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            {market === "Total" ? "Total" : "Handicap"}
            <input value={line} onChange={(e) => setLine(e.target.value)} placeholder={market === "Total" ? "6.5" : "-1.5"} inputMode="decimal" className={`${inputCls} w-20`} />
          </label>
        )}
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Odds
          <input
            value={odds}
            onChange={(e) => setOdds(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="+110"
            inputMode="numeric"
            className={`${inputCls} w-20`}
          />
        </label>
        <button onClick={add} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90">
          Add
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-warn">{error}</p>}
      <p className="mt-2 text-[11px] text-muted">
        For a puck line enter that side&apos;s own handicap (the favorite is −1.5, the underdog +1.5). Whole-number lines are priced with the push refunded.
      </p>

      {entries.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="px-3 py-1.5 text-left font-medium">Book</th>
                <th className="px-3 py-1.5 text-left font-medium">Bet</th>
                <th className="px-3 py-1.5 text-right font-medium">Price</th>
                <th className="px-3 py-1.5 text-right font-medium" title="The win probability that price needs to break even (includes the vig)">
                  Break-even
                </th>
                <th className="px-3 py-1.5 text-right font-medium">Model</th>
                <th className="px-3 py-1.5 text-right font-medium">Model price</th>
                <th className="px-3 py-1.5 text-right font-medium">Edge (pts)</th>
                <th className="px-3 py-1.5 text-right font-medium">EV</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map(({ id, book: b, row: r }) => {
                const live = r.ev > 0;
                return (
                  <tr key={id} className={`border-b border-border last:border-0 ${live ? "bg-accent/10" : ""}`}>
                    <td className="px-3 py-1.5 text-muted">{b || "—"}</td>
                    <td className="px-3 py-1.5 text-foreground">
                      {r.side} <span className="text-muted">({r.market.toLowerCase()})</span>
                      {r.ev >= 0.03 && <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-background">EDGE</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-up">{fmtOdds(r.bookOdds)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{pct(r.bookImplied)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-foreground">{pct(r.model)}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-foreground">{fairOdds(r.model)}</td>
                    <td className={`px-3 py-1.5 text-right font-mono ${r.edgePts > 0 ? "text-up" : "text-down"}`}>{pts(r.edgePts)}</td>
                    <td className={`px-3 py-1.5 text-right font-mono ${live ? "text-accent" : "text-muted"}`}>
                      {r.ev >= 0 ? "+" : ""}
                      {(r.ev * 100).toFixed(1)}%
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => setEntries((e) => e.filter((x) => x.id !== id))} className="text-muted hover:text-foreground" title="Remove">
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
