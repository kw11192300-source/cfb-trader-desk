"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-runs the page's server render every `seconds` while the tab is visible, so a live board stays current (and its "x minutes ago" stays true) without a reload. */
export default function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
