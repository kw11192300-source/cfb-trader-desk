import Link from "next/link";

type Sport = "cfb" | "nfl" | "nhl";

// Each sport's nav is scoped to what it actually has - NFL/NHL have no
// model/odds pipeline yet (see /nfl/page.tsx, /nhl/page.tsx), so they get
// Board+Bets only rather than CFB's full tool list sitting there unused.
const NAV_ITEMS: Record<Sport, { href: string; label: string; prefetch?: boolean }[]> = {
  cfb: [
    { href: "/", label: "Board", prefetch: false },
    { href: "/my-games", label: "My Games" },
    { href: "/oddscreen", label: "Odds Screen" },
    { href: "/ratings", label: "Ratings" },
    { href: "/edges", label: "Edges" },
    { href: "/watchlist", label: "Watchlist" },
    { href: "/sharp-money", label: "Sharp Money" },
    { href: "/bets", label: "Bets" },
    { href: "/risk", label: "Risk" },
    { href: "/backtest", label: "Backtest" },
    { href: "/futures", label: "Futures" },
  ],
  nfl: [
    { href: "/nfl", label: "Board" },
    { href: "/nfl/bets", label: "Bets" },
  ],
  nhl: [
    { href: "/nhl", label: "Board" },
    { href: "/nhl/edges", label: "Edges" },
    { href: "/nhl/performance", label: "Edge log" },
    { href: "/nhl/teams", label: "Teams" },
    { href: "/nhl/goalies", label: "Goalies" },
    { href: "/nhl/bets", label: "Bets" },
  ],
};

const SPORT_LABEL: Record<Sport, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL" };
const SPORT_HOME: Record<Sport, string> = { cfb: "/", nfl: "/nfl", nhl: "/nhl" };
const ALL_SPORTS: Sport[] = ["cfb", "nfl", "nhl"];

export default function SiteHeader({ subtitle, sport = "cfb" }: { subtitle: string; sport?: Sport }) {
  const items = NAV_ITEMS[sport];

  return (
    <header className="border-b border-border bg-surface px-6 py-4">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={SPORT_HOME[sport]} prefetch={false}>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {SPORT_LABEL[sport]} <span className="text-accent">Trader Desk</span>
            </h1>
          </Link>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        <nav className="flex items-center gap-4 text-xs">
          {items.map((item) => (
            <Link key={item.href} href={item.href} prefetch={item.prefetch} className="text-muted transition-colors hover:text-foreground">
              {item.label}
            </Link>
          ))}
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            {ALL_SPORTS.map((s) => (
              <Link
                key={s}
                href={SPORT_HOME[s]}
                prefetch={false}
                className={`rounded px-2 py-1 font-medium transition-colors ${
                  s === sport ? "bg-accent text-background" : "text-muted hover:text-foreground"
                }`}
              >
                {SPORT_LABEL[s]}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2 text-muted">
            <span className="h-2 w-2 rounded-full bg-up" />
            live
          </div>
        </nav>
      </div>
    </header>
  );
}
