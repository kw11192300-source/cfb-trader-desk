"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import { pickHeadlineLine as pickCfbdHeadline, spreadMovement } from "@/lib/lines";
import { formatPrice, formatSpread, mergeLines, pickHeadlineLine } from "@/lib/mergedLines";
import { pickPerspectiveSpread } from "@/lib/spread";
import type { BoardRow } from "@/lib/types";

function TeamLogo({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <div className="h-6 w-6 shrink-0 rounded-full bg-white/90 ring-1 ring-black/10" />;
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/90 ring-1 ring-black/10">
      <Image src={src} alt={alt} width={18} height={18} className="h-[18px] w-[18px] object-contain" unoptimized />
    </div>
  );
}

function MoveCell({ delta, direction }: { delta: number; direction: "up" | "down" | "flat" }) {
  if (direction === "flat") return <span className="text-flat">flat</span>;
  const color = direction === "up" ? "text-up" : "text-down";
  const arrow = direction === "up" ? "▲" : "▼";
  return (
    <span className={color}>
      {arrow} {Math.abs(delta).toFixed(1)}
    </span>
  );
}

type SortKey = "kickoff" | "spread" | "total" | "move" | "books" | "edge";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "kickoff", label: "Kickoff" },
  { key: "spread", label: "Spread", align: "right" },
  { key: "total", label: "Total", align: "right" },
  { key: "move", label: "Move", align: "right" },
  { key: "books", label: "Books", align: "right" },
  { key: "edge", label: "Edge", align: "right" },
];

/** One row's worth of everything GameCard already derives per game -
 * duplicated here rather than shared, same as this codebase's existing
 * per-file small-formatter convention (NflGameCard/BetsLedger each have
 * their own tiny fmt helpers rather than a shared util). */
function deriveRow(row: BoardRow) {
  const { game, lines, oddsApiLines, homeLogo, awayLogo, prediction } = row;
  const books = mergeLines(lines, oddsApiLines);
  const headline = pickHeadlineLine(books);
  const cfbdHeadline = pickCfbdHeadline(lines);
  const sMove = cfbdHeadline ? spreadMovement(cfbdHeadline) : null;
  const edge = prediction?.edge_spread ?? null;
  const hasModel = edge !== null && Math.abs(edge) > 0.05;
  const pickHome = hasModel ? edge > 0 : false;
  const pickTeam = pickHome ? game.home_team : game.away_team;
  const { model: modelView } = hasModel ? pickPerspectiveSpread(prediction!.market_spread, prediction!.predicted_margin, pickHome) : { model: null };
  return { game, homeLogo, awayLogo, books, headline, sMove, edge, hasModel, pickTeam, modelView };
}

/** Sort value per column - null always sorts to the bottom regardless of
 * direction (a game with "no total yet" shouldn't jump to the top just
 * because you flipped to descending). */
function sortValue(d: ReturnType<typeof deriveRow>, key: SortKey): number | null {
  switch (key) {
    case "kickoff":
      return new Date(d.game.start_date).getTime();
    case "spread":
      return d.headline?.homeSpread ?? null;
    case "total":
      return d.headline?.total ?? null;
    case "move":
      return d.sMove ? Math.abs(d.sMove.delta) : null;
    case "books":
      return d.books.length;
    case "edge":
      return d.hasModel ? Math.abs(d.edge!) : null;
  }
}

export default function BoardTable({ rows }: { rows: BoardRow[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("kickoff");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const derived = useMemo(() => rows.map(deriveRow), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = q === "" ? derived : derived.filter((d) => d.game.home_team.toLowerCase().includes(q) || d.game.away_team.toLowerCase().includes(q));
    const dir = sortDir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  }, [derived, query, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "kickoff" ? "asc" : "desc"); // kickoff: soonest first; everything else: biggest first
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by team…"
          className="w-56 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {query.trim() !== "" && (
          <span className="text-xs text-muted">
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-8 shadow-card text-center text-muted">No games found for the current week yet.</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-8 shadow-card text-center text-muted">No matchups match &quot;{query}&quot;.</div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-xs font-mono uppercase tracking-wide text-muted">
                <th className="sticky top-0 left-0 z-20 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={`sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium ${c.align === "right" ? "text-right" : ""}`}>
                    <button onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 transition-colors hover:text-foreground">
                      {c.label}
                      {sortKey === c.key && <span className="text-accent">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.game.id} className={`border-b border-border last:border-0 hover:bg-surface-raised ${d.hasModel ? "bg-gold/[0.06]" : "odd:bg-surface/50"}`}>
                  <td className={`sticky left-0 z-10 bg-background px-4 py-2.5 whitespace-nowrap ${d.hasModel ? "border-l-2 border-l-gold" : ""}`}>
                    <Link href={`/games/${d.game.id}`} className="group flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 text-foreground group-hover:text-accent">
                        <TeamLogo src={d.awayLogo} alt={d.game.away_team} />
                        <span>{d.game.away_team}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-foreground group-hover:text-accent">
                        <TeamLogo src={d.homeLogo} alt={d.game.home_team} />
                        <span>{d.game.home_team}</span>
                      </div>
                    </Link>
                  </td>
                  <td className="border-l border-border px-4 py-2.5 font-mono text-xs whitespace-nowrap text-muted">
                    {d.game.completed ? (
                      <span className="font-medium text-muted">FINAL</span>
                    ) : d.game.live_status ? (
                      <span className="font-medium text-down">LIVE</span>
                    ) : (
                      <LocalDateTime iso={d.game.start_date} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} />
                    )}
                  </td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono whitespace-nowrap text-foreground">
                    {d.headline ? formatSpread(d.game.home_team, d.game.away_team, d.headline.homeSpread) : "—"}
                    {d.headline?.homeSpreadPrice !== null && d.headline?.homeSpreadPrice !== undefined && (
                      <div className="text-[10px] text-muted">{formatPrice(d.headline.homeSpreadPrice)}</div>
                    )}
                  </td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono whitespace-nowrap text-foreground">
                    {d.headline?.total !== null && d.headline?.total !== undefined ? `O/U ${d.headline.total.toFixed(1)}` : "—"}
                  </td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono whitespace-nowrap">{d.sMove ? <MoveCell delta={d.sMove.delta} direction={d.sMove.direction} /> : <span className="text-muted">—</span>}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono whitespace-nowrap text-muted">{d.books.length}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono whitespace-nowrap">
                    {d.hasModel ? (
                      <span className="font-bold text-gold" title={`Model likes ${d.pickTeam} ${d.modelView !== null ? d.modelView.toFixed(1) : ""}`}>
                        {Math.abs(d.edge!).toFixed(1)}
                      </span>
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
