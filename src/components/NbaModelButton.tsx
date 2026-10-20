"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getNbaLiveStatus, triggerNbaLive } from "@/lib/actions";

const POLL_MS = 5000;
const GIVE_UP_MS = 8 * 60 * 1000;
const ET = "America/New_York";

/** "Update model": reads the newest injury report and lines, then rebuilds projected minutes, stat lines and the model's spread /
 * total / moneyline for the games coming up. Takes a few minutes (GitHub runs the job); the page reloads when it finishes. The same
 * job also starts on its own whenever the injury report changes. */
export default function NbaModelButton({ updatedAt }: { updatedAt: string | null }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pending, startTransition] = useTransition();
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(async () => {
      const s = await getNbaLiveStatus();
      const mine = s.createdAt !== null && new Date(s.createdAt).getTime() >= startedAt.current - 15_000;
      if (mine && (s.state === "success" || s.state === "failed")) {
        setWaiting(false);
        setMessage(s.state === "success" ? "Model updated." : "The projection job failed - see the run on GitHub.");
        if (s.state === "success") router.refresh();
      } else if (Date.now() - startedAt.current > GIVE_UP_MS) {
        setWaiting(false);
        setMessage("Still running - refresh the page in a minute or two.");
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [waiting, router]);

  const busy = pending || waiting;
  const stamp = updatedAt ? new Date(updatedAt).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
      <button
        disabled={busy}
        title="Reads the latest injury report and lines, then rebuilds projected minutes, stat lines and the model's spread / total / moneyline. Takes a few minutes."
        onClick={() =>
          startTransition(async () => {
            startedAt.current = Date.now();
            const r = await triggerNbaLive();
            setMessage(r.message);
            if (r.ok) setWaiting(true);
          })
        }
        className="rounded-md border border-accent/60 px-3 py-1.5 font-medium text-accent transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Starting…" : waiting ? "Updating model…" : "Update model"}
      </button>
      <span className="text-muted">
        {message ?? (stamp ? `Model last built ${stamp} ET. It also rebuilds on its own whenever the injury report changes.` : "No projections built yet - press Update model.")}
      </span>
    </div>
  );
}
