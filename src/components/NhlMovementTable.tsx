"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import NhlTeamLogo from "./NhlTeamLogo";
import type { MoveRow } from "@/lib/nhlMovement";

const MAX_ROWS = 500;

const SIZE_OPTIONS = [
  { label: "Any size", value: 0 },
  { label: "5¢ or more", value: 5 },
  { label: "10¢ or more", value: 10 },
  { label: "20¢ or more", value: 20 },
];

const selectCls = "rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none";
const nick = (t: string) => t.split(" ").slice(-1)[0];

/** "6.5 (o+110 / u-130)" -> the number on top, its prices small underneath, so line moves don't stretch the table. */
function Price({ text, strong }: { text: string; strong?: boolean }) {
  const i = text.indexOf(" (");
  if (i < 0) return <>{text}</>;
  return (
    <>
      <div>{text.slice(0, i)}</div>
      <div className={`text-[10px] font-normal ${strong ? "text-muted" : "text-muted/80"}`}>{text.slice(i + 2, -1)}</div>
    </>
  );
}

/** "3h 12m before the game" for a move, "after the start" if it happened once the game was under way. */
function lead(atIso: string, startIso: string): string {
  const mins = Math.round((new Date(startIso).getTime() - new Date(atIso).getTime()) / 60000);
  if (mins < 0) return "after the start";
  if (mins < 60) return `${mins}m before the game`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m before the game`;
  return `${Math.round(h / 24)} days before the game`;
}

/** Every DraftKings price or line change we've saved, newest first. */
export default function NhlMovementTable({ rows }: { rows: MoveRow[] }) {
  const [market, setMarket] = useState<"all" | MoveRow["market"]>("all");
  const [minSize, setMinSize] = useState(0);
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (market === "all" || r.market === market) &&
        (r.kind === "line" || r.size >= minSize) &&
        (q === "" || `${r.home} ${r.away}`.toLowerCase().includes(q)),
    );
  }, [rows, market, minSize, query]);
  const visible = shown.slice(0, MAX_ROWS);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by team…"
          className="w-44 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <select value={market} onChange={(e) => setMarket(e.target.value as typeof market)} className={selectCls}>
          <option value="all">All markets</option>
          <option value="Moneyline">Moneyline</option>
          <option value="Puck line">Puck line</option>
          <option value="Total">Total</option>
        </select>
        <select value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} className={selectCls} title="Price moves smaller than this are hidden; line moves always show">
          {SIZE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">
          {shown.length} of {rows.length} moves{shown.length > MAX_ROWS ? ` (latest ${MAX_ROWS} shown)` : ""}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          {rows.length === 0 ? "No price moves saved yet - they appear here as the odds timer picks up changes." : "Nothing matches that filter."}
        </div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Moved</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Game</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Market</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">What</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">Was</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">Now</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium" title="Price moves: change in the side's implied probability, in points. Line moves: change in the number.">
                  Move
                </th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium" title="Size of the price move in cents (-105 to +100 is 5 cents)">
                  Size
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const tone = r.dir > 0 ? "text-up" : "text-down";
                const move = r.kind === "price" ? `${(r.probPts ?? 0) >= 0 ? "+" : ""}${(r.probPts ?? 0).toFixed(1)} pts` : `${r.dir > 0 ? "+" : "-"}${r.size}`;
                return (
                  <tr key={r.key} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-foreground">
                        <LocalDateTime iso={r.at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                      </div>
                      <div className="text-[11px] text-muted">{lead(r.at, r.startDate)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/nhl/games/${r.gameId}`} prefetch={false} className="block hover:underline">
                        <span className="flex items-center gap-1.5 whitespace-nowrap text-foreground">
                          <NhlTeamLogo team={r.away} size={18} />
                          {nick(r.away)}
                          <span className="text-muted">@</span>
                          <NhlTeamLogo team={r.home} size={18} />
                          {nick(r.home)}
                        </span>
                        <span className="text-[11px] text-muted">
                          Game: <LocalDateTime iso={r.startDate} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} />
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{r.market}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-foreground">{r.what}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap text-muted">
                      <Price text={r.was} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold whitespace-nowrap text-foreground">
                      <Price text={r.now} strong />
                    </td>
                    <td className={`px-3 py-2 text-right font-mono text-xs font-semibold whitespace-nowrap ${tone}`}>{move}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap text-foreground">{r.kind === "price" ? `${r.size}¢` : "line"}</td>
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
