import Link from "next/link";

/** Plain links, not client state - the URL itself is the source of truth
 * (bare basePath = current week, "basePath?week=N" = a specific one) so
 * the Board always defaults to current week on a fresh visit, exactly
 * like before this existed, while still being linkable/bookmarkable to a
 * past or future week. basePath defaults to "/" (CFB's Board) - NFL's
 * Board passes "/nfl" so the same component drives both. */
export default function WeekTabs({
  weeks,
  activeWeek,
  currentWeek,
  basePath = "/",
}: {
  weeks: number[];
  activeWeek: number;
  currentWeek: number;
  basePath?: string;
}) {
  if (weeks.length <= 1) return null;
  return (
    <div className="mb-4 flex w-fit gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1">
      {weeks.map((w) => (
        <Link
          key={w}
          href={w === currentWeek ? basePath : `${basePath}?week=${w}`}
          prefetch={false}
          className={`shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
            w === activeWeek ? "bg-accent text-background" : "text-muted hover:text-foreground"
          }`}
        >
          Week {w}
          {w === currentWeek ? " •" : ""}
        </Link>
      ))}
    </div>
  );
}
