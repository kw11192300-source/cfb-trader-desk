"use client";

import { useState } from "react";
import { logBet } from "@/app/edges/actions";

export default function LogBetForm({
  gameId,
  modelVersion,
  market,
  side,
  line,
}: {
  gameId: number;
  modelVersion: string | null;
  market: string;
  side: string;
  line: number;
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
      <input type="hidden" name="line" value={line} />
      <input
        type="number"
        name="stake"
        placeholder="Stake"
        step="0.01"
        min="0.01"
        required
        className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <input
        type="number"
        name="odds"
        placeholder="-110"
        className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
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
