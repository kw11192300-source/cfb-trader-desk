"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const useMounted = () => useSyncExternalStore(subscribe, () => true, () => false);

/** The "pick a game" dropdown: its labels carry the kickoff date in the viewer's own timezone, which a server-rendered list cannot do. */
export default function GameSelect({ name, value, anyLabel, games }: { name: string; value: string; anyLabel: string; games: { id: string; sport: string; away: string; home: string; start: string }[] }) {
  const mounted = useMounted();
  return (
    <select name={name} defaultValue={value} className="max-w-[260px] rounded border border-border bg-background px-2 py-1 text-foreground">
      <option value="">{anyLabel}</option>
      {games.map((g) => (
        <option key={g.id} value={g.id}>{`${g.sport.toUpperCase()} · ${g.away} @ ${g.home}${mounted ? ` · ${new Date(g.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`}</option>
      ))}
    </select>
  );
}
