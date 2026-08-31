"use client";

import { useSyncExternalStore } from "react";

/**
 * Formats a date/time using the VIEWER's own timezone, not the server's.
 *
 * Next.js Server Components render once on the server — on Vercel that's
 * UTC — so `new Date(iso).toLocaleString()` called directly in a Server
 * Component shows the server's timezone forever, not yours. A Client
 * Component fixes this once it hydrates, but naively formatting during the
 * render that happens *before* hydration would still briefly show the
 * server's (wrong) value and risk a hydration mismatch.
 *
 * This renders nothing until mounted, then formats using the browser's
 * timezone — SSR and the first client render both produce the same "empty"
 * output (no mismatch), and the real value appears an instant later.
 * useSyncExternalStore (rather than a useEffect + setState "isMounted"
 * flag) is the pattern React itself recommends for this — no subscription
 * ever fires, it's purely used for its differing server/client snapshots.
 *
 * Ported from the sibling CFB Pick 'Em app (same bug, same fix — see its
 * commit "Fix kickoff times showing wrong on production").
 */
const subscribe = () => () => {};

function useIsMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

export default function LocalDateTime({ iso, options }: { iso: string; options: Intl.DateTimeFormatOptions }) {
  const mounted = useIsMounted();
  if (!mounted) return null;
  return <>{new Date(iso).toLocaleString(undefined, options)}</>;
}
