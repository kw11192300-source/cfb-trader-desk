"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshNba } from "@/lib/actions";

/** "Update scores": reads ESPN right now (a few seconds) for scores, live status, finals and lines, then settles any prop bet on a
 * game that just finished from its box score. The same update runs on a timer every ~10 minutes. */
export default function NbaScoresButton() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
      <button
        disabled={pending}
        title="Pulls today's scores, live status, finals and lines from ESPN right now, and grades prop bets on finished games from the box score"
        onClick={() =>
          start(async () => {
            const r = await refreshNba();
            setMessage(r.message);
            if (r.ok) router.refresh();
          })
        }
        className="rounded-md border border-up/50 px-3 py-1.5 font-medium text-up transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Updating scores…" : "Update scores"}
      </button>
      <span className="text-muted">{message ?? "Scores, lines and prop grading also update on their own every few minutes."}</span>
    </div>
  );
}
