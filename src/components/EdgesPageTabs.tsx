"use client";

import { useState } from "react";
import BetsLedger from "./BetsLedger";
import EdgeBacktestPanel from "./EdgeBacktestPanel";
import EdgesTable from "./EdgesTable";
import type { EdgeRow, GradedBet } from "@/lib/data";
import type { ModelBacktest, ModelBacktestGame } from "@/lib/types";

type Tab = "picks" | "backtest" | "bets";

export default function EdgesPageTabs({
  rows,
  generatedAt,
  backtestResults,
  backtestGames,
  bets,
}: {
  rows: EdgeRow[];
  generatedAt: string | null;
  backtestResults: Record<string, ModelBacktest[]>;
  backtestGames: ModelBacktestGame[];
  bets: GradedBet[];
}) {
  const [tab, setTab] = useState<Tab>("picks");

  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
        <button
          onClick={() => setTab("picks")}
          className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
            tab === "picks" ? "bg-accent text-background" : "text-muted hover:text-foreground"
          }`}
        >
          This Week&apos;s Picks
        </button>
        <button
          onClick={() => setTab("bets")}
          className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
            tab === "bets" ? "bg-accent text-background" : "text-muted hover:text-foreground"
          }`}
        >
          My Bets
        </button>
        <button
          onClick={() => setTab("backtest")}
          className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
            tab === "backtest" ? "bg-accent text-background" : "text-muted hover:text-foreground"
          }`}
        >
          Backtest
        </button>
      </div>

      {tab === "picks" && <EdgesTable rows={rows} generatedAt={generatedAt} />}
      {tab === "bets" && <BetsLedger bets={bets} />}
      {tab === "backtest" && <EdgeBacktestPanel results={backtestResults} games={backtestGames} />}
    </div>
  );
}
