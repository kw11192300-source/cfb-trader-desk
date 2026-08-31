"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import {
  SPREAD_WIDE_THRESHOLD,
  TOTAL_WIDE_THRESHOLD,
  bestMoneylineSide,
  bestSpreadSide,
  bestTotalSide,
  formatMoneyline,
  formatSpreadCell,
  formatTotalCell,
  moneylineHold,
  mostRecentFetch,
  spreadDisagreement,
  totalDisagreement,
  type DisplayLine,
} from "@/lib/mergedLines";
import type { Game } from "@/lib/types";

type Row = { game: Game; books: DisplayLine[]; homeLogo: string | null; awayLogo: string | null };

function TeamLogo({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return <div className="h-7 w-7 shrink-0 rounded-full bg-white/90 ring-1 ring-black/10" />;
  }
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/90 ring-1 ring-black/10">
      <Image src={src} alt={alt} width={22} height={22} className="h-[22px] w-[22px] object-contain" unoptimized />
    </div>
  );
}

function formatRelativeTime(iso: string, now: number): string {
  const diffSec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

/** Ticks every 30s so "Xm ago" stays accurate on a page left open. */
function FreshnessBanner({ iso }: { iso: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!iso) return null;
  return (
    <div className="mb-3 text-xs text-muted">
      Data as of <span className="text-foreground">{formatRelativeTime(iso, now)}</span> — spreads/totals poll every ~15 min, juice/book
      breadth every ~6 hrs.
    </div>
  );
}

type Tab = "spread" | "total" | "ml";

const TABS: { key: Tab; label: string }[] = [
  { key: "spread", label: "Spread" },
  { key: "total", label: "Total" },
  { key: "ml", label: "Moneyline" },
];

/** Two lines in one cell — top/bottom always paired with the Matchup
 * column's away-top/home-bottom (or over-top/under-bottom for totals). */
function StackedCell({ top, bottom, highlightTop, highlightBottom, sub }: { top: string; bottom: string; highlightTop?: boolean; highlightBottom?: boolean; sub?: [string | null, string | null] }) {
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className={highlightTop ? "text-up" : "text-foreground"}>
        {top}
        {sub?.[0] && <div className="text-[10px] text-muted">{sub[0]}</div>}
      </div>
      <div className={highlightBottom ? "text-up" : "text-foreground"}>
        {bottom}
        {sub?.[1] && <div className="text-[10px] text-muted">{sub[1]}</div>}
      </div>
    </div>
  );
}

export default function OddsScreenTable({ rows }: { rows: Row[] }) {
  const [tab, setTab] = useState<Tab>("spread");
  const [query, setQuery] = useState("");

  const bookKeys = Array.from(new Map(rows.flatMap((r) => r.books).map((b) => [b.bookKey, b.bookName])).entries());
  const freshestFetch = mostRecentFetch(rows.flatMap((r) => r.books));

  const q = query.trim().toLowerCase();
  const filteredRows = q === "" ? rows : rows.filter((r) => r.game.home_team.toLowerCase().includes(q) || r.game.away_team.toLowerCase().includes(q));

  return (
    <div>
      <FreshnessBanner iso={freshestFetch} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
                tab === t.key ? "bg-accent text-background" : "text-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by team…"
          className="w-56 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {q !== "" && (
          <span className="text-xs text-muted">
            {filteredRows.length} match{filteredRows.length === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {rows.length === 0 || bookKeys.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No lines available yet this week.</div>
      ) : filteredRows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No matchups match &quot;{query}&quot;.</div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                <th className="sticky top-0 left-0 z-20 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium">Best Price</th>
                {bookKeys.map(([key, name]) => (
                  <th key={key} className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ game, books, homeLogo, awayLogo }) => {
                const byBook = new Map(books.map((b) => [b.bookKey, b]));

                let bestTop: { point: number | null; price: number | null; bookName: string } | null;
                let bestBottom: { point: number | null; price: number | null; bookName: string } | null;
                let renderCell: (b: DisplayLine | undefined) => { top: string; bottom: string };
                let renderBest: () => { top: string; bottom: string; topBook: string | null; bottomBook: string | null };

                if (tab === "spread") {
                  bestTop = bestSpreadSide(books, "away");
                  bestBottom = bestSpreadSide(books, "home");
                  renderCell = (b) => ({
                    top: b ? formatSpreadCell(b.awaySpread, b.awaySpreadPrice) : "—",
                    bottom: b ? formatSpreadCell(b.homeSpread, b.homeSpreadPrice) : "—",
                  });
                  renderBest = () => ({
                    top: bestTop ? formatSpreadCell(bestTop.point, bestTop.price) : "—",
                    bottom: bestBottom ? formatSpreadCell(bestBottom.point, bestBottom.price) : "—",
                    topBook: bestTop?.bookName ?? null,
                    bottomBook: bestBottom?.bookName ?? null,
                  });
                } else if (tab === "total") {
                  bestTop = bestTotalSide(books, "over");
                  bestBottom = bestTotalSide(books, "under");
                  renderCell = (b) => ({
                    top: b ? formatTotalCell("o", b.total, b.overPrice) : "—",
                    bottom: b ? formatTotalCell("u", b.total, b.underPrice) : "—",
                  });
                  renderBest = () => ({
                    top: bestTop ? formatTotalCell("o", bestTop.point, bestTop.price) : "—",
                    bottom: bestBottom ? formatTotalCell("u", bestBottom.point, bestBottom.price) : "—",
                    topBook: bestTop?.bookName ?? null,
                    bottomBook: bestBottom?.bookName ?? null,
                  });
                } else {
                  bestTop = bestMoneylineSide(books, "away");
                  bestBottom = bestMoneylineSide(books, "home");
                  renderCell = (b) => ({
                    top: b ? formatMoneyline(b.awayMoneyline) : "—",
                    bottom: b ? formatMoneyline(b.homeMoneyline) : "—",
                  });
                  renderBest = () => ({
                    top: bestTop ? formatMoneyline(bestTop.price) : "—",
                    bottom: bestBottom ? formatMoneyline(bestBottom.price) : "—",
                    topBook: bestTop?.bookName ?? null,
                    bottomBook: bestBottom?.bookName ?? null,
                  });
                }

                const best = renderBest();

                // Flags: book disagreement (spread/total) or hold/arbitrage (moneyline) —
                // whichever's relevant to the active tab, shown next to kickoff time.
                let flag: { label: string; title: string; tone: "warn" | "arb" } | null = null;
                if (tab === "spread") {
                  const delta = spreadDisagreement(books);
                  if (delta !== null && delta >= SPREAD_WIDE_THRESHOLD) {
                    flag = { label: `Δ${delta.toFixed(1)}`, title: `Spread varies ${delta.toFixed(1)} points across books — worth a second look.`, tone: "warn" };
                  }
                } else if (tab === "total") {
                  const delta = totalDisagreement(books);
                  if (delta !== null && delta >= TOTAL_WIDE_THRESHOLD) {
                    flag = { label: `Δ${delta.toFixed(1)}`, title: `Total varies ${delta.toFixed(1)} points across books — worth a second look.`, tone: "warn" };
                  }
                } else {
                  const hold = moneylineHold(books);
                  if (hold) {
                    flag = hold.isArbitrage
                      ? { label: "ARB", title: `Betting both sides at their best-price books nets a guaranteed profit (${Math.abs(hold.holdPct).toFixed(1)}% edge).`, tone: "arb" }
                      : { label: `${hold.holdPct.toFixed(1)}%`, title: "Combined book edge (hold) using the best price on each side (normal is ~4-5%).", tone: "warn" };
                  }
                }

                return (
                  <tr key={game.id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                    <td className="sticky left-0 z-10 bg-background px-4 py-3 whitespace-nowrap">
                      <Link href={`/games/${game.id}`} className="group flex flex-col gap-1">
                        <div className="flex items-center gap-2 text-[10px] text-muted">
                          <LocalDateTime iso={game.start_date} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                          {flag && (
                            <span
                              title={flag.title}
                              className={`rounded px-1.5 py-0.5 font-mono font-medium ${flag.tone === "arb" ? "bg-up/20 text-up" : "bg-amber-400/20 text-amber-400"}`}
                            >
                              {flag.label}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-foreground group-hover:text-accent">
                          <TeamLogo src={awayLogo} alt={game.away_team} />
                          <span>{game.away_team}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-foreground group-hover:text-accent">
                          <TeamLogo src={homeLogo} alt={game.home_team} />
                          <span>{game.home_team}</span>
                        </div>
                      </Link>
                    </td>
                    <td className="border-l border-border px-4 py-3 font-mono whitespace-nowrap">
                      <StackedCell top={best.top} bottom={best.bottom} highlightTop={best.top !== "—"} highlightBottom={best.bottom !== "—"} sub={[best.topBook, best.bottomBook]} />
                    </td>
                    {bookKeys.map(([key]) => {
                      const b = byBook.get(key);
                      const cell = renderCell(b);
                      return (
                        <td key={key} className="border-l border-border px-4 py-3 font-mono whitespace-nowrap text-foreground">
                          <StackedCell top={cell.top} bottom={cell.bottom} />
                        </td>
                      );
                    })}
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
