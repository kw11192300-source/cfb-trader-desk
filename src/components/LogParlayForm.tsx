"use client";

import { useState } from "react";
import { logBet } from "@/lib/actions";

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

/** A parlay spans multiple games/markets at once, so it doesn't fit the
 * per-game LogBetForm/LogPropBetForm pattern at all - this is a top-
 * level control, not attached to any one game card. Legs are free text
 * (one per line), not tied to a real game_id/market/side each - a parlay
 * is always settled manually (see schema.sql's manual_result docstring),
 * so there's no need to model each leg structurally just to re-derive a
 * result the sportsbook's own slip already tells you. */
export default function LogParlayForm({ sport = "cfb" }: { sport?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-foreground"
      >
        + Log Parlay
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
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
    >
      <input type="hidden" name="sport" value={sport} />
      <input type="hidden" name="market" value="parlay" />
      <input type="hidden" name="edge_source" value="market" />
      <label className="text-xs text-muted">
        Legs (one per line, at least 2)
        <textarea
          name="legs"
          required
          rows={4}
          placeholder={"Chiefs -3.5\nMahomes Over 275.5 Passing Yards\nKelce Anytime TD"}
          className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="number"
          name="odds"
          placeholder="Combined odds (e.g. +450)"
          required
          className="w-40 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <input
          type="number"
          name="stake"
          placeholder="Units"
          step="0.001"
          min="0.001"
          required
          className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <input
          type="text"
          name="sportsbook"
          list="parlay-sportsbook-options"
          placeholder="Book"
          className="w-28 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <datalist id="parlay-sportsbook-options">
          {COMMON_BOOKS.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "…" : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-foreground">
          Cancel
        </button>
      </div>
    </form>
  );
}
