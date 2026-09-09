"use client";

import { useState } from "react";
import { logBet } from "@/lib/actions";

// Suggestions only, not a fixed list - real prop markets are too varied
// to enumerate (same reasoning as sportsbook/prop_type being free text
// in schema.sql).
const COMMON_PROP_TYPES = [
  "Passing Yards",
  "Rushing Yards",
  "Receiving Yards",
  "Receptions",
  "Rushing Attempts",
  "Passing Attempts",
  "Passing TDs",
  "Rushing + Receiving Yards",
  "Anytime TD",
  "Completions",
];
const COMMON_BOOKS = [
  "DraftKings",
  "FanDuel",
  "BetMGM",
  "Caesars",
  "ESPN Bet",
  "Fanatics",
  "Pinnacle",
  "Circa",
  "Bet365",
  "Boomers",
  "STN",
  "William Hill",
];

/** Player props have no auto-grading path (no player-stats feed exists -
 * see schema.sql's manual_result docstring), so every one of these sits
 * pending until settled by hand on the Bets ledger. Deliberately a
 * separate component from LogBetForm rather than another market option
 * on it - the field shape genuinely differs (player + prop type, free-
 * text side) not just the market label. */
export default function LogPropBetForm({ gameId, sport = "cfb" }: { gameId: number; sport?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-foreground"
      >
        Prop
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
      <input type="hidden" name="sport" value={sport} />
      <input type="hidden" name="market" value="prop" />
      <input type="hidden" name="edge_source" value="market" />
      <input
        type="text"
        name="player"
        placeholder="Player"
        required
        className="w-28 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <input
        type="text"
        name="prop_type"
        list="prop-type-options"
        placeholder="Prop type"
        required
        className="w-32 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <datalist id="prop-type-options">
        {COMMON_PROP_TYPES.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <select
        name="side"
        defaultValue="Over"
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
      >
        <option value="Over">Over</option>
        <option value="Under">Under</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
      <input
        type="number"
        name="line"
        placeholder="Line"
        step="0.5"
        defaultValue={0}
        className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <input
        type="number"
        name="stake"
        placeholder="Units"
        step="0.001"
        min="0.001"
        required
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
        list="prop-sportsbook-options"
        placeholder="Book"
        className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <datalist id="prop-sportsbook-options">
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
      <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground">
        Cancel
      </button>
    </form>
  );
}
