import Link from "next/link";

const seasonLabel = (s: number) => `${s}-${String(s + 1).slice(2)}`;

/** Season picker + Season/Last-10 toggle for the Teams and Goalies pages. Plain links, so it stays a server component. */
export default function NhlStatControls({
  basePath,
  seasons,
  season,
  scope,
  hasL10,
}: {
  basePath: string;
  seasons: number[];
  season: number;
  scope: "all" | "l10";
  hasL10: boolean;
}) {
  const href = (s: number, sc: "all" | "l10") => `${basePath}?season=${s}${sc === "l10" ? "&scope=l10" : ""}`;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {hasL10 && (
        <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
          {(
            [
              ["all", "Season"],
              ["l10", "Last 10"],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={href(season, key)}
              prefetch={false}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${scope === key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
            >
              {label}
            </Link>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
        {seasons.map((s) => (
          <Link
            key={s}
            href={href(s, "all")}
            prefetch={false}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${s === season ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
          >
            {seasonLabel(s)}
          </Link>
        ))}
      </div>
    </div>
  );
}
