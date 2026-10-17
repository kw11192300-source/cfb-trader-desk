"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getCfbScoresStatus, triggerCfbScores } from "@/lib/actions";

const POLL_MS = 4000;
const GIVE_UP_MS = 4 * 60 * 1000;

/** "Update scores": runs the ESPN score sync right now (the same job that already runs every 5 minutes) and reloads the
 * page when it finishes. Takes about a minute: GitHub queues the run, ESPN is read, the games table is updated. */
export default function CfbScoresButton() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pending, startTransition] = useTransition();
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(async () => {
      const s = await getCfbScoresStatus();
      // only count a run that began after the click (an older finished run is still "the latest" for a few seconds)
      const mine = s.createdAt !== null && new Date(s.createdAt).getTime() >= startedAt.current - 15_000;
      if (mine && (s.state === "success" || s.state === "failed")) {
        setWaiting(false);
        setMessage(s.state === "success" ? "Scores updated." : "The score sync failed - see the run on GitHub.");
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
        title="Pulls live scores and finals from ESPN right now (the site also does this every 5 minutes on its own). Takes about a minute."
        onClick={() =>
          startTransition(async () => {
            startedAt.current = Date.now();
            const r = await triggerCfbScores();
            setMessage(r.message);
            if (r.ok) setWaiting(true);
          })
        }
        className="rounded-md border border-up/50 px-3 py-1.5 font-medium text-up transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Starting…" : waiting ? "Updating scores…" : "Update scores"}
      </button>
      {message ? <span className="text-muted">{message}</span> : <span className="text-muted">Scores also sync from ESPN every 5 minutes on their own.</span>}
    </div>
  );
}
