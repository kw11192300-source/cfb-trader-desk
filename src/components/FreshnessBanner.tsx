"use client";

import { useEffect, useState } from "react";

export function formatRelativeTime(iso: string, now: number): string {
  const diffSec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

/** Ticks every 30s so "Xm ago" stays accurate on a page left open. */
export default function FreshnessBanner({ iso }: { iso: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!iso) return null;
  return (
    <div className="mb-4 text-xs text-muted">
      Data as of <span className="text-foreground">{formatRelativeTime(iso, now)}</span> — spreads/totals poll every ~15 min, juice/book
      breadth every ~6 hrs.
    </div>
  );
}
