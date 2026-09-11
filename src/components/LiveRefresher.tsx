"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_INTERVAL_MS = 60_000;

/** Silently re-fetches this page's server data every 60s, but ONLY while
 * `active` is true. Real cadences checked before picking this: CFB scores
 * sync every 5 min (sync_results_espn.py), NFL every 15 (sync_nfl_espn.py)
 * - polling faster than that would mostly just re-fetch identical data,
 * and polling at all when nothing's live would be pure waste. Renders
 * nothing; the parent server component decides `active` (does any game
 * on this page currently have live_status set). */
export default function LiveRefresher({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, router]);

  return null;
}
