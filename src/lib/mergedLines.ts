import { isModelProjection } from "./lines";
import type { BettingLine, OddsApiLine } from "./types";

/**
 * One book's line, combined from whichever source(s) have it. The Odds API
 * (real per-side juice, wider book set) is always preferred when a book
 * appears in both; CFBD fills in books Odds API doesn't carry (ESPN Bet,
 * as of this writing) without a price, rather than dropping them.
 */
export type DisplayLine = {
  bookKey: string;
  bookName: string;
  homeSpread: number | null;
  homeSpreadPrice: number | null;
  awaySpread: number | null;
  awaySpreadPrice: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  hasPrice: boolean;
};

const DISPLAY_ORDER = ["draftkings", "fanduel", "betmgm", "espn bet", "caesars", "betrivers", "bovada"];

function bookKeyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(ag|net|com)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Odds API's own bookmaker `key` is already a clean slug (e.g. "draftkings") — prefer it when present. */
function keyFromOddsApi(l: OddsApiLine): string {
  return bookKeyOf(l.bookmaker);
}

const TITLE_OVERRIDES: Record<string, string> = {
  betonlineag: "BetOnline",
  mybookieag: "MyBookie",
  lowvig: "LowVig",
  betrivers: "BetRivers",
};

function titleFor(key: string, fallback: string): string {
  return TITLE_OVERRIDES[key] ?? fallback;
}

export function mergeLines(cfbdLines: BettingLine[], oddsApiLines: OddsApiLine[]): DisplayLine[] {
  const byKey = new Map<string, DisplayLine>();

  for (const l of oddsApiLines) {
    const key = keyFromOddsApi(l);
    byKey.set(key, {
      bookKey: key,
      bookName: titleFor(key, l.bookmaker_title),
      homeSpread: l.home_spread,
      homeSpreadPrice: l.home_spread_price,
      awaySpread: l.away_spread,
      awaySpreadPrice: l.away_spread_price,
      total: l.total,
      overPrice: l.over_price,
      underPrice: l.under_price,
      homeMoneyline: l.home_moneyline,
      awayMoneyline: l.away_moneyline,
      hasPrice: true,
    });
  }

  for (const l of cfbdLines) {
    if (isModelProjection(l.provider)) continue;
    const key = bookKeyOf(l.provider === "Draft Kings" ? "DraftKings" : l.provider);
    if (byKey.has(key)) continue; // Odds API version already has real pricing — keep it
    byKey.set(key, {
      bookKey: key,
      bookName: titleFor(key, l.provider),
      homeSpread: l.spread,
      homeSpreadPrice: null,
      awaySpread: l.spread !== null ? -l.spread : null,
      awaySpreadPrice: null,
      total: l.over_under,
      overPrice: null,
      underPrice: null,
      homeMoneyline: l.home_moneyline,
      awayMoneyline: l.away_moneyline,
      hasPrice: false,
    });
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const ai = DISPLAY_ORDER.indexOf(a.bookKey);
    const bi = DISPLAY_ORDER.indexOf(b.bookKey);
    const ra = ai === -1 ? DISPLAY_ORDER.length : ai;
    const rb = bi === -1 ? DISPLAY_ORDER.length : bi;
    return ra - rb;
  });
}

/** Renders a spread the way sportsbooks conventionally do, e.g. "TCU -7.5". */
export function formatSpread(homeTeam: string, awayTeam: string, spread: number | null): string {
  if (spread === null) return "—";
  if (spread === 0) return "Pick 'em";
  return spread < 0 ? `${homeTeam} ${spread}` : `${awayTeam} -${spread}`;
}

export function formatMoneyline(ml: number | null): string {
  if (ml === null) return "—";
  return ml > 0 ? `+${ml}` : `${ml}`;
}

/** American-odds juice, e.g. -110 or +100. Distinct from formatMoneyline only in the "no data" case. */
export function formatPrice(price: number | null): string | null {
  if (price === null) return null;
  return price > 0 ? `+${price}` : `${price}`;
}

export function pickHeadlineLine(lines: DisplayLine[]): DisplayLine | null {
  if (lines.length === 0) return null;
  const draftKings = lines.find((l) => l.bookKey === "draftkings" && l.homeSpread !== null);
  const anyWithSpread = lines.find((l) => l.homeSpread !== null);
  return draftKings ?? anyWithSpread ?? lines[0];
}

export function bestHomeSpread(lines: DisplayLine[]): number | null {
  const withSpread = lines.filter((l) => l.homeSpread !== null);
  if (withSpread.length === 0) return null;
  return Math.max(...withSpread.map((l) => l.homeSpread!));
}

export function bestOverTotal(lines: DisplayLine[]): number | null {
  const withTotal = lines.filter((l) => l.total !== null);
  if (withTotal.length === 0) return null;
  return Math.max(...withTotal.map((l) => l.total!));
}

export function bestUnderTotal(lines: DisplayLine[]): number | null {
  const withTotal = lines.filter((l) => l.total !== null);
  if (withTotal.length === 0) return null;
  return Math.min(...withTotal.map((l) => l.total!));
}
