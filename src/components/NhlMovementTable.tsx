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
const th = "sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium";

/** "3h 12m before the game" for a move, "after the start" if it happened once the game was under way. */
function lead(atIso: string, startIso: string): string {
  const mins = Math.round((new Date(startIso).getTime() - new Date(atIso).getTime()) / 60000);
  if (mins < 0) return "after the start";
  if (mins < 60) return `${mins}m before the game`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m before the game`;
  return `${Math.round(h / 24)} days before the game`;
}

const fmtSize = (r: MoveRow) => (r.kind === "price" ? `${r.size}¢` : `${r.size % 1 === 0 ? r.size.toFixed(0) : r.size.toFixed(1)} goal${r.size === 1 ? "" : "s"}`);

/** Every DraftKings market move we've saved - one row per market, both sides together - newest first. */
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
                <th className={th}>Moved</th>
                <th className={th}>Game</th>
                <th className={th} title="The side the market moved toward: the one that became more likely">
                  Moved toward
                </th>
                <th className={th} />
                <th className={`${th} text-right`}>Was</th>
                <th className={`${th} text-right`}>Now</th>
                <th className={`${th} text-right`} title="Price moves: how far the no-vig win probability shifted toward that side, in points, and below it the biggest price change on either side in cents (-105 to +100 is 5 cents). Line moves: the change in the number.">
                  How far
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const tone = r.tone === "up" ? "text-up" : r.tone === "down" ? "text-down" : "text-foreground";
                const how = r.kind === "price" ? `${(r.pts ?? 0).toFixed(1)} pts` : r.tone === "up" ? `+${fmtSize(r)}` : r.tone === "down" ? `-${fmtSize(r)}` : fmtSize(r);
                return (
                  <tr key={r.key} className="border-b border-border align-top last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
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
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`flex items-center gap-1.5 font-semibold ${tone}`}>
                        {r.toward.team && <NhlTeamLogo team={r.toward.team} size={18} />}
                        {r.toward.label}
                      </span>
                      <span className="text-[11px] text-muted">{r.market}</span>
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-muted">
                      {r.sides.map((s) => (
                        <div key={s.label}>{s.label}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap text-muted">
                      {r.sides.map((s) => (
                        <div key={s.label}>{s.was}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-semibold whitespace-nowrap text-foreground">
                      {r.sides.map((s) => (
                        <div key={s.label}>{s.now}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap">
                      <div className={`font-semibold ${tone}`}>{how}</div>
                      {r.kind === "price" && <div className="text-[11px] text-muted">{fmtSize(r)}</div>}
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
