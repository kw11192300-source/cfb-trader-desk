"use client";

import { useRouter } from "next/navigation";
import NhlTeamLogo from "./NhlTeamLogo";

/** Team dropdown (and, with no team chosen yet, a logo grid) for the schedule page. */
export default function NhlTeamPicker({ teams, current }: { teams: string[]; current: string | null }) {
  const router = useRouter();
  const go = (t: string) => router.push(t ? `/nhl/schedule?team=${encodeURIComponent(t)}` : "/nhl/schedule");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {current && <NhlTeamLogo team={current} size={32} />}
        <select
          value={current ?? ""}
          onChange={(e) => go(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        >
          <option value="">Choose a team…</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {!current && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {teams.map((t) => (
            <button
              key={t}
              onClick={() => go(t)}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-3 text-xs text-foreground transition-colors hover:border-accent"
            >
              <NhlTeamLogo team={t} size={36} />
              {t.split(" ").slice(-1)[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
