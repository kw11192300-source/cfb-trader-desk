"use client";

import { useEffect, useState } from "react";

/** How old the DraftKings prices are, ticking once a minute: green while the 10-minute timer is clearly alive, amber when
 * it looks late, red when it has probably stopped (check cron-job.org). Renders nothing until mounted (no hydration mismatch). */
export default function OddsAge({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return null;
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  const state = mins <= 20 ? "up" : mins <= 45 ? "warn" : "down";
  const dot = state === "up" ? "bg-up" : state === "warn" ? "bg-warn" : "bg-down";
  const text = state === "up" ? "text-muted" : state === "warn" ? "text-warn" : "text-down";
  const age = mins < 1 ? "just now" : mins < 60 ? `${mins} min old` : `${Math.floor(mins / 60)}h ${mins % 60}m old`;
  const hint = state === "up" ? "" : state === "warn" ? " - the 10-minute timer looks late" : " - the timer has probably stopped; check cron-job.org";
  return (
    <span className={`inline-flex items-center gap-1.5 ${text}`} title="Time since the odds timer last checked DraftKings">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {age}
      {hint}
    </span>
  );
}
