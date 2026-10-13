"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import NhlTeamLogo from "./NhlTeamLogo";
import type { ModelMoveRow } from "@/lib/nhlModelMoves";

const MAX_ROWS = 500;

const SIZE_OPTIONS = [
  { label: "Any size", value: 0 },
  { label: "0.5 pts or more", value: 0.5 },
  { label: "1 pt or more", value: 1 },
  { label: "2 pts or more", value: 2 },
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

/** Every change in the model's numbers, newest first - the counterpart of the line-moves table, with the reason. */
export default function NhlModelMovesTable({ rows }: { rows: ModelMoveRow[] }) {
  const [kind, setKind] = useState<"all" | ModelMoveRow["kind"]>("all");
  const [minPts, setMinPts] = useState(0);
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (kind === "all" || r.kind === kind) &&
        (minPts === 0 || r.pts >= minPts || Math.abs(r.totalDelta) >= 0.1) &&
        (q === "" || `${r.home} ${r.away}`.toLowerCase().includes(q)),
    );
  }, [rows, kind, minPts, query]);
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
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={selectCls}>
          <option value="all">All reasons</option>
          <option value="goalie">Goalie news</option>
          <option value="rerun">Model refresh</option>
        </select>
        <select value={minPts} onChange={(e) => setMinPts(Number(e.target.value))} className={selectCls} title="Hides small changes; a change of 0.1 goals or more in the expected total always shows">
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
          {rows.length === 0 ? "No model changes saved yet - they appear here when a goalie is confirmed, switched or the model refreshes." : "Nothing matches that filter."}
        </div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                <th className={th}>Moved</th>
                <th className={th}>Game · reason</th>
                <th className={th} title="The side whose win probability went up, and by how many points; the change in the expected total is underneath">
                  Moved toward · how far
                </th>
                <th className={th} />
                <th className={`${th} text-right`}>Was</th>
                <th className={`${th} text-right`}>Now</th>
                <th className={`${th} text-right`} title="Did our number move toward DraftKings' (the gap shrank) or away from it? Gap before to after, in win-probability points, at the prices of that moment.">
                  vs DraftKings
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
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
                    </Link>
                    <div className={`mt-0.5 max-w-[22rem] text-[11px] leading-snug ${r.kind === "goalie" ? "text-accent" : "text-muted"}`}>{r.reason}</div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="flex items-center gap-1.5 font-semibold text-foreground">
                      {r.toward.team && <NhlTeamLogo team={r.toward.team} size={18} />}
                      {r.toward.label}
                    </span>
                    <span className="font-mono text-[11px] text-muted">
                      {r.pts >= 0.05 ? `+${r.pts.toFixed(1)} pts` : ""}
                      {r.pts >= 0.05 && Math.abs(r.totalDelta) >= 0.005 ? " · " : ""}
                      {Math.abs(r.totalDelta) >= 0.005 ? `total ${r.totalDelta > 0 ? "+" : ""}${r.totalDelta.toFixed(2)}` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap text-muted">
                    {r.lines.map((l) => (
                      <div key={l.label}>{l.label}</div>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap text-muted">
                    {r.lines.map((l) => (
                      <div key={l.label}>{l.was}</div>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold whitespace-nowrap text-foreground">
                    {r.lines.map((l) => (
                      <div key={l.label}>{l.now}</div>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                    {r.vsBook ? (
                      <>
                        <div className={`font-semibold ${r.vsBook.closer ? "text-up" : "text-down"}`}>{r.vsBook.closer ? "Closer" : "Further"}</div>
                        <div className="font-mono text-[11px] text-muted">
                          {r.vsBook.before.toFixed(1)} → {r.vsBook.after.toFixed(1)} pts
                        </div>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
