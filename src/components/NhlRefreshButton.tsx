"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import LocalDateTime from "./LocalDateTime";
import { getNhlRefreshStatus, refreshNhlOdds, triggerNhlRefresh, type NhlRefreshStatus } from "@/lib/actions";

const TIME = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;

/** Kicks off the NHL model refresh in GitHub's cloud (see nhl-refresh.yml) - works from any device, no
 * computer of yours needs to be on. Polls while a run is in flight and reloads the board when it finishes. */
export default function NhlRefreshButton({
  lastPublished,
  oddsUpdated = null,
  initial,
  variant = "model",
}: {
  lastPublished: string | null;
  oddsUpdated?: string | null;
  initial: NhlRefreshStatus;
  /** "tables" = the Teams / Goalies pages: same cloud run, worded for the data tables, no DK-odds button. */
  variant?: "model" | "tables";
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [oddsPending, startOddsTransition] = useTransition();
  const active = status.state === "queued" || status.state === "running";
  const wasActive = useRef(active);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(async () => setStatus(await getNhlRefreshStatus()), 15000);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (wasActive.current && !active && status.state === "success") router.refresh();
    wasActive.current = active;
  }, [active, status.state, router]);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-xs">
      <div className="text-muted">
        {variant === "tables" ? "Tables last updated" : "Model last published"}: {lastPublished ? <LocalDateTime iso={lastPublished} options={TIME} /> : <span className="text-foreground">never</span>}
        {oddsUpdated && (
          <>
            {" "}
            · DK odds as of <LocalDateTime iso={oddsUpdated} options={TIME} />
          </>
        )}
      </div>
      <button
        disabled={pending || active}
        onClick={() =>
          startTransition(async () => {
            const r = await triggerNhlRefresh();
            setMessage(r.message);
            setStatus(await getNhlRefreshStatus());
          })
        }
        className="rounded-md bg-accent px-3 py-1.5 font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Starting…" : active ? "Refreshing…" : variant === "tables" ? "Update data" : "Refresh model"}
      </button>
      {variant === "model" && (
      <button
        disabled={oddsPending}
        title="Re-reads ESPN's DraftKings lines in a few seconds - doesn't refit the model"
        onClick={() =>
          startOddsTransition(async () => {
            const r = await refreshNhlOdds();
            setMessage(r.message);
            if (r.ok) router.refresh();
          })
        }
        className="rounded-md border border-up/50 px-3 py-1.5 font-medium text-up transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {oddsPending ? "Updating odds…" : "Update DK odds"}
      </button>
      )}
      <div className="text-muted">
        {status.state === "queued" && "Queued - waiting for a GitHub runner…"}
        {status.state === "running" && (variant === "tables" ? "Running - pulling new games and rebuilding the tables (about 10 minutes)…" : "Running - updating results, refitting, simulating…")}
        {status.state === "success" && status.updatedAt && (
          <>
            Last run succeeded <LocalDateTime iso={status.updatedAt} options={TIME} />
          </>
        )}
        {status.state === "failed" && status.url && (
          <span className="text-down">
            Last run failed -{" "}
            <a href={status.url} target="_blank" rel="noreferrer" className="underline">
              view log
            </a>
          </span>
        )}
        {status.state === "none" && "No refresh run yet."}
      </div>
      {message && <div className="basis-full text-muted">{message}</div>}
    </div>
  );
}
