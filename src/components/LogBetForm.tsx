"use client";

import { useState } from "react";
import { logBet } from "@/lib/actions";

// Common books, offered as autocomplete suggestions - free text either way,
// since some books the user actually uses aren't in Odds API/CFBD coverage
// and have to be logged manually regardless.
const COMMON_BOOKS = ["DraftKings", "FanDuel", "BetMGM", "Caesars", "ESPN Bet", "Fanatics", "Pinnacle", "Circa", "Bet365", "Boomers"];

export default function LogBetForm({
  gameId,
  modelVersion,
  market,
  side,
  line,
  suggestedUnits,
}: {
  gameId: number;
  modelVersion: string | null;
  market: string;
  side: string;
  line: number;
  suggestedUnits?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-foreground"
      >
        Log bet
      </button>
    );
  }

  return (
    <form
      action={async (formData) => {
        setPending(true);
        try {
          await logBet(formData);
          setOpen(false);
        } finally {
          setPending(false);
        }
      }}
      className="flex flex-wrap items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <input type="hidden" name="game_id" value={gameId} />
      <input type="hidden" name="model_version" value={modelVersion ?? ""} />
      <input type="hidden" name="market" value={market} />
      <input type="hidden" name="side" value={side} />
      <input
        type="number"
        name="line"
        defaultValue={line}
        step="0.5"
        title="Spread actually taken - edit if it differs from the market number shown above"
        className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <select
        name="edge_source"
        defaultValue="model"
        title="What justified this bet"
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
      >
        <option value="model">Model</option>
        <option value="market">Market</option>
        <option value="both">Both</option>
      </select>
      <input
        type="number"
        name="stake"
        placeholder="Units"
        step="0.5"
        min="0.5"
        defaultValue={suggestedUnits ?? undefined}
        required
        title={suggestedUnits ? `Suggested: ${suggestedUnits} units` : undefined}
        className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <input
        type="number"
        name="odds"
        placeholder="-110"
        className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <input
        type="text"
        name="sportsbook"
        list="sportsbook-options"
        placeholder="Book"
        className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <datalist id="sportsbook-options">
        {COMMON_BOOKS.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "…" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground"
      >
        Cancel
      </button>
    </form>
  );
}
