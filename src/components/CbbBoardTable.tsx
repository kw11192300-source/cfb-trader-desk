"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import CbbLogo from "./CbbLogo";
import type { CbbBoardRow } from "@/lib/types";

type SortKey = "time" | "spread" | "total" | "mover";

const ET = "America/New_York";
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: ET });
const dayLabel = (key: string, todayKey: string) => {
  if (key === todayKey) return "Today";
  const d = new Date(`${key}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });

const f1 = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(1));
/** A home-margin number as the home team's spread line: margin +5.5 -> "-5.5". */
const line = (margin: number | null | undefined) => (margin === null || margin === undefined || Number.isNaN(margin) ? "—" : `${margin > 0 ? "-" : margin < 0 ? "+" : ""}${Math.abs(margin).toFixed(1)}`);
const amer = (p: number | null | undefined) => (p === null || p === undefined ? "—" : p > 0 ? `+${p}` : `${p}`);

function Play({ label, clv, strong }: { label: string | null; clv: number | null; strong: boolean }) {
  if (!label || clv === null) return <span className="text-muted">—</span>;
  return (
    <span className={strong ? "font-semibold text-up" : "text-foreground"}>
      {label} <span className="font-mono text-xs">+{clv.toFixed(1)}</span>
    </span>
  );
}

/** The CBB board: one row per upcoming game with the model's number, where the line should close and the side that earns
 * closing-line value now. Day tabs, sortable by start time, spread CLV, total CLV, or how far the line should still move. */
export default function CbbBoardTable({ rows, initialSort = "time", showDays = true }: { rows: CbbBoardRow[]; initialSort?: SortKey; showDays?: boolean }) {
  const todayKey = dayKey(new Date().toISOString());
  const days = useMemo(() => [...new Set(rows.map((r) => dayKey(r.start_date)))].sort(), [rows]);
  const [day, setDay] = useState<string>(days.includes(todayKey) ? todayKey : (days[0] ?? "all"));
  const [sort, setSort] = useState<SortKey>(initialSort);
  const [query, setQuery] = useState("");
  const [minClv, setMinClv] = useState(0);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => {
      const p = r.payload;
      const best = Math.max(r.spread_clv ?? 0, r.total_clv ?? 0);
      return (
        (!showDays || day === "all" || dayKey(r.start_date) === day) &&
        (q === "" || `${p.teams?.home ?? r.home_team} ${p.teams?.away ?? r.away_team} ${r.home_team} ${r.away_team}`.toLowerCase().includes(q)) &&
        best >= minClv
      );
    });
    const key = (r: CbbBoardRow): number => {
      if (sort === "spread") return -(r.spread_clv ?? -1);
      if (sort === "total") return -(r.total_clv ?? -1);
      if (sort === "mover") return -Math.abs(r.payload.move.remaining_spread ?? 0);
      return new Date(r.start_date).getTime();
    };
    return list.sort((a, b) => key(a) - key(b));
  }, [rows, day, sort, query, minClv, showDays]);

  const btn = (active: boolean) =>
    `rounded-md border px-2.5 py-1 text-xs ${active ? "border-accent bg-accent/15 text-foreground" : "border-border bg-surface text-muted hover:text-foreground"}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {showDays && (
          <div className="flex flex-wrap gap-1.5">
            {days.map((d) => (
              <button key={d} onClick={() => setDay(d)} className={btn(day === d)}>
                {dayLabel(d, todayKey)}
              </button>
            ))}
            <button onClick={() => setDay("all")} className={btn(day === "all")}>
              All
            </button>
          </div>
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter team…"
          className="w-40 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Min CLV
          <select value={minClv} onChange={(e) => setMinClv(Number(e.target.value))} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground">
            {[0, 0.5, 1, 1.5, 2].map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "any" : `${v}+ pts`}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          Sort
          {(
            [
              ["time", "Time"],
              ["spread", "Spread CLV"],
              ["total", "Total CLV"],
              ["mover", "Biggest mover"],
            ] as [SortKey, string][]
          ).map(([k, l]) => (
            <button key={k} onClick={() => setSort(k)} className={btn(sort === k)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          No games on the board for this view yet. Lines usually appear the evening before; the board refreshes as new numbers post.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-2.5 font-medium">Time</th>
                <th className="px-3 py-2.5 font-medium">Game</th>
                <th className="px-2 py-2.5 text-right font-medium" title="The home team's spread when it opened → where it is now">Home spread open → now</th>
                <th className="px-2 py-2.5 text-right font-medium" title="Our projected home spread">Model</th>
                <th className="px-2 py-2.5 text-right font-medium" title="Where we expect the spread to close">Exp. close</th>
                <th className="px-3 py-2.5 font-medium" title="The side that should gain closing-line value at the number up now, and the expected points of it">Spread play (CLV)</th>
                <th className="px-2 py-2.5 text-right font-medium" title="Total: open → now">Total open → now</th>
                <th className="px-2 py-2.5 text-right font-medium" title="Our projected total">Model</th>
                <th className="px-2 py-2.5 text-right font-medium" title="Where we expect the total to close">Exp. close</th>
                <th className="px-3 py-2.5 font-medium" title="Over or under, and the expected points of closing-line value">Total play (CLV)</th>
                <th className="px-3 py-2.5 font-medium" title="Moneyline: the side whose price should shorten, with the expected change in implied win probability">ML play</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const p = r.payload;
                const home = p.teams?.home ?? r.home_team;
                const away = p.teams?.away ?? r.away_team;
                const sp = p.bets.spread;
                const tt = p.bets.total;
                const ml = p.bets.ml;
                const spreadLabel = sp.side === "home" ? home : sp.side === "away" ? away : null;
                return (
                  <tr key={r.game_id} className="border-b border-border/60 hover:bg-surface-raised/50">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{timeLabel(r.start_date)}</td>
                    <td className="px-3 py-2">
                      <Link href={`/cbb/games/${r.game_id}`} className="flex items-center gap-1.5 hover:text-accent">
                        <CbbLogo teamId={r.away_team_id} size={18} />
                        <span>{away}</span>
                        <span className="text-muted">@</span>
                        <CbbLogo teamId={r.home_team_id} size={18} />
                        <span className="font-medium">{home}</span>
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-xs">
                      {line(p.market.open_margin)} → <span className="text-foreground">{line(p.market.cur_margin)}</span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{line(p.model.spread)}</td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{line(p.move.exp_close_margin)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Play label={spreadLabel ? `${spreadLabel}` : null} clv={sp.clv} strong={(sp.clv ?? 0) >= 1} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-xs">
                      {f1(p.market.open_total)} → <span className="text-foreground">{f1(p.market.cur_total)}</span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{f1(p.model.total)}</td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{f1(p.move.exp_close_total)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Play label={tt.side ? tt.side.toUpperCase() : null} clv={tt.clv} strong={(tt.clv ?? 0) >= 1} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      {ml.side ? (
                        <span className="text-foreground">
                          {ml.side === "home" ? home : away}{" "}
                          <span className="font-mono text-muted">
                            {amer(ml.side === "home" ? p.model.fair_ml_home : p.model.fair_ml_away)} fair · +{Math.abs((ml.clv_p ?? 0) * 100).toFixed(1)}%
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
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
