"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getCbbBoardStatus, refreshCbb, runCbbModel } from "@/lib/actions";
import LocalDateTime from "./LocalDateTime";

const POLL_MS = 5000;
const GIVE_UP_MS = 6 * 60 * 1000;

/** Two buttons for the college basketball board. "Update scores & lines" reads ESPN right now (seconds): scores, live status and the lines
 * up now (the same update runs on a timer every ~10 minutes). "Update model" does that and then rescores every game on the board against
 * the new lines (a minute or two in GitHub Actions); the page reloads when it finishes. */
export default function CbbRefreshButtons({ updatedAt, scoresOnly = false }: { updatedAt: string | null; scoresOnly?: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pending, start] = useTransition();
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(async () => {
      const s = await getCbbBoardStatus();
      const mine = s.createdAt !== null && new Date(s.createdAt).getTime() >= startedAt.current - 15_000;
      if (mine && (s.state === "success" || s.state === "failed")) {
        setWaiting(false);
        setMessage(s.state === "success" ? "Board rescored." : "The board job failed - see the run on GitHub.");
        if (s.state === "success") router.refresh();
      } else if (Date.now() - startedAt.current > GIVE_UP_MS) {
        setWaiting(false);
        setMessage("Still running - refresh the page in a minute.");
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, router]);

  const busy = pending || waiting;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
      <button
        disabled={busy}
        title="Pulls scores, live status and the lines up now from ESPN (a few seconds)"
        onClick={() =>
          start(async () => {
            const r = await refreshCbb();
            setMessage(r.message);
            if (r.ok) router.refresh();
          })
        }
        className="rounded-md border border-up/50 px-3 py-1.5 font-medium text-up transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending && !waiting ? "Updating…" : "Update scores & lines"}
      </button>
      {!scoresOnly && (
      <button
        disabled={busy}
        title="Reads the latest lines, then rescores every game on the board (a minute or two)"
        onClick={() =>
          start(async () => {
            startedAt.current = Date.now();
            const r = await runCbbModel();
            setMessage(r.message);
            if (r.ok) setWaiting(true);
          })
        }
        className="rounded-md border border-accent/60 px-3 py-1.5 font-medium text-accent transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {waiting ? "Updating model…" : "Update model"}
      </button>
      )}
      <span className="text-muted">
        {message ??
          (scoresOnly ? "Scores and lines also update on their own every few minutes; bets settle from the final score." : updatedAt ? (
            <>
              Board last scored <LocalDateTime iso={updatedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }} />. Lines and scores also refresh on their own every few minutes.
            </>
          ) : (
            "Nothing scored yet - lines appear the evening before tip-off."
          ))}
      </span>
    </div>
  );
}
