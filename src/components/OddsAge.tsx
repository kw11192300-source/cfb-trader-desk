"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getNhlOddsFetchedAt } from "@/lib/actions";

/** How old the DraftKings prices are: green while the 10-minute timer is clearly alive, amber when it looks late, red when it
 * has probably stopped (check cron-job.org). The age is checked against the database once a minute - not the page's
 * load-time value - so a tab left open all day stays truthful; when newer prices exist the board reloads its data itself. */
export default function OddsAge({ iso }: { iso: string }) {
  const router = useRouter();
  const [polled, setPolled] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const loaded = useRef(iso);
  useEffect(() => {
    loaded.current = iso; // what the page was rendered with; a router.refresh() brings a newer value
  }, [iso]);
  const latest = polled && polled > iso ? polled : iso;

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const clock = setInterval(tick, 30_000);
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      const fresh = await getNhlOddsFetchedAt();
      if (!fresh) return;
      setPolled((cur) => (cur && cur > fresh ? cur : fresh));
      if (fresh > loaded.current) router.refresh(); // pull the newer prices into the page
    };
    void poll();
    const id = setInterval(poll, 60_000);
    const onVisible = () => void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(clock);
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  if (now === null) return null;
  const mins = Math.max(0, Math.round((now - new Date(latest).getTime()) / 60000));
  const state = mins <= 20 ? "up" : mins <= 45 ? "warn" : "down";
  const dot = state === "up" ? "bg-up" : state === "warn" ? "bg-warn" : "bg-down";
  const text = state === "up" ? "text-muted" : state === "warn" ? "text-warn" : "text-down";
  const age = mins < 1 ? "just now" : mins < 60 ? `${mins} min old` : `${Math.floor(mins / 60)}h ${mins % 60}m old`;
  const hint = state === "up" ? "" : state === "warn" ? " - the 10-minute timer looks late" : " - the timer has probably stopped; check cron-job.org";
  return (
    <span className={`inline-flex items-center gap-1.5 ${text}`} title="Time since the odds timer last checked DraftKings (checked against the database every minute)">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {age}
      {hint}
    </span>
  );
}
