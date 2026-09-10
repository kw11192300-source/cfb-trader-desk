import { Activity, BarChart3, CalendarClock, Eye, History, LayoutDashboard, Receipt, Star, Table2, TrendingUp, Zap, type LucideIcon } from "lucide-react";

export type Sport = "cfb" | "nfl";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  prefetch?: boolean;
  /** Shown in the mobile bottom bar directly; everything else lives
   * behind "More". Kept to ~4 per sport so the bar doesn't get cramped. */
  primary?: boolean;
};

// Each sport's nav is scoped to what it actually has - NFL has no model/
// odds pipeline yet (see /nfl/page.tsx), so it gets Board+Bets only
// rather than CFB's full tool list sitting there unused.
export const NAV_ITEMS: Record<Sport, NavItem[]> = {
  cfb: [
    { href: "/", label: "Board", icon: LayoutDashboard, prefetch: false, primary: true },
    { href: "/my-games", label: "My Games", icon: Star },
    { href: "/oddscreen", label: "Odds Screen", icon: Table2 },
    { href: "/ratings", label: "Ratings", icon: BarChart3 },
    { href: "/edges", label: "Edges", icon: Zap },
    { href: "/watchlist", label: "Watchlist", icon: Eye, primary: true },
    { href: "/sharp-money", label: "Sharp Money", icon: TrendingUp },
    { href: "/bets", label: "Bets", icon: Receipt, primary: true },
    { href: "/risk", label: "Risk", icon: Activity, primary: true },
    { href: "/backtest", label: "Backtest", icon: History },
    { href: "/futures", label: "Futures", icon: CalendarClock },
  ],
  nfl: [
    { href: "/nfl", label: "Board", icon: LayoutDashboard, primary: true },
    { href: "/nfl/bets", label: "Bets", icon: Receipt, primary: true },
  ],
};

export const SPORT_LABEL: Record<Sport, string> = { cfb: "CFB", nfl: "NFL" };
export const SPORT_HOME: Record<Sport, string> = { cfb: "/", nfl: "/nfl" };
export const OTHER_SPORT: Record<Sport, Sport> = { cfb: "nfl", nfl: "cfb" };
