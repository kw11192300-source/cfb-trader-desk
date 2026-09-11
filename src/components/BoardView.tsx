"use client";

import { useSyncExternalStore } from "react";
import BoardTable from "./BoardTable";
import TraderBoard from "./TraderBoard";
import type { BoardRow, LineSnapshot } from "@/lib/types";

type ViewMode = "table" | "cards";
const STORAGE_KEY = "board-view-mode";
// localStorage's own "storage" event only fires in OTHER tabs, not the
// one that called setItem - this custom event covers the same-tab case
// (clicking the toggle) so useSyncExternalStore actually re-renders here.
const CHANGE_EVENT = "board-view-mode-change";

function readStored(): ViewMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "table" || saved === "cards") return saved;
  } catch {
    // localStorage can throw (private mode, blocked storage) - falls
    // through to the default below, nothing else depends on this.
  }
  return "table";
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function getServerSnapshot(): ViewMode {
  return "table"; // matches the client's pre-hydration value - no localStorage during SSR
}

/** Card/table toggle for the Board - `page.tsx` stays a server component
 * (force-dynamic, fetches everything up front, same as every other page)
 * and hands this the same props TraderBoard already took; the toggle
 * itself is the only client-side state on the page, same architecture
 * OddsScreenTable/RatingsTable already use for their own filter state.
 * Defaults to Table - the whole point of adding it - but remembers
 * whatever you actually pick, the way a real tool should.
 *
 * Reads the preference via useSyncExternalStore rather than a plain
 * useState+useEffect - that combination is exactly what this hook exists
 * for (synchronizing with a source outside React, like localStorage),
 * and it handles the server/first-paint-vs-real-value swap correctly on
 * its own, instead of a hand-rolled "hydrated" flag doing the same job
 * less precisely. */
export default function BoardView({ rows, lineHistory }: { rows: BoardRow[]; lineHistory?: Map<number, LineSnapshot[]> }) {
  const mode = useSyncExternalStore(subscribe, readStored, getServerSnapshot);

  function choose(next: ViewMode) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // best-effort - a failed write just means the choice won't persist
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
        {(["table", "cards"] as ViewMode[]).map((m) => (
          <button
            key={m}
            onClick={() => choose(m)}
            className={`rounded px-4 py-1.5 text-xs font-medium capitalize transition-colors ${mode === m ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "table" ? <BoardTable rows={rows} /> : <TraderBoard rows={rows} lineHistory={lineHistory} />}
    </div>
  );
}
