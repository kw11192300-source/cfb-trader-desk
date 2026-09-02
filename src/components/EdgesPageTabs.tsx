"use client";

import { useState } from "react";
import EdgeBacktestPanel from "./EdgeBacktestPanel";
import EdgesTable from "./EdgesTable";
import type { EdgeRow } from "@/lib/data";
import type { ModelBacktest } from "@/lib/types";

type Tab = "picks" | "backtest";

export default function EdgesPageTabs({
  rows,
  generatedAt,
  backtestResults,
}: {
  rows: EdgeRow[];
  generatedAt: string | null;
  backtestResults: Record<string, ModelBacktest[]>;
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
          onClick={() => setTab("backtest")}
          className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
            tab === "backtest" ? "bg-accent text-background" : "text-muted hover:text-foreground"
          }`}
        >
          Backtest
        </button>
      </div>

      {tab === "picks" ? <EdgesTable rows={rows} generatedAt={generatedAt} /> : <EdgeBacktestPanel results={backtestResults} />}
    </div>
  );
}
