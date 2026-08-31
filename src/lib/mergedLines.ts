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
  /** When this book's line was last fetched — odds_api_lines.fetched_at when
   * sourced from The Odds API, betting_lines.fetched_at otherwise. Powers
   * the "data as of" freshness indicator. */
  fetchedAt: string | null;
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
      fetchedAt: l.fetched_at,
    });
  }

  for (const l of cfbdLines) {
    if (isModelProjection(l.provider)) continue;
    const key = bookKeyOf(l.provider === "Draft Kings" ? "DraftKings" : l.provider);
    const existing = byKey.get(key);
    if (existing) {
      // Same book in both sources — Odds API's markets win where it has
      // them, but fill in anything it's missing from CFBD (e.g. a book with
      // spreads/totals from Odds API but no h2h market posted there, even
      // though CFBD does carry that book's moneyline) rather than silently
      // dropping real data just because the row came from Odds API first.
      byKey.set(key, {
        ...existing,
        homeSpread: existing.homeSpread ?? l.spread,
        awaySpread: existing.awaySpread ?? (l.spread !== null ? -l.spread : null),
        total: existing.total ?? l.over_under,
        homeMoneyline: existing.homeMoneyline ?? l.home_moneyline,
        awayMoneyline: existing.awayMoneyline ?? l.away_moneyline,
        fetchedAt: existing.fetchedAt ?? l.fetched_at,
      });
      continue;
    }
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
      fetchedAt: l.fetched_at,
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

/** Lower is better for an over bettor — easier to clear a smaller number. */
export function bestOverTotal(lines: DisplayLine[]): number | null {
  const withTotal = lines.filter((l) => l.total !== null);
  if (withTotal.length === 0) return null;
  return Math.min(...withTotal.map((l) => l.total!));
}

/** Higher is better for an under bettor — easier to stay below a bigger number. */
export function bestUnderTotal(lines: DisplayLine[]): number | null {
  const withTotal = lines.filter((l) => l.total !== null);
  if (withTotal.length === 0) return null;
  return Math.max(...withTotal.map((l) => l.total!));
}

// --- "Best price" picks: best number for a given side, tie-broken by juice ---
// (e.g. if three books all have home -7, the one with the least-negative/most-
// positive price wins the tie — same point, better payout).

export type BestPick = { bookName: string; point: number | null; price: number | null };

/** Missing price sorts as worse than any real price, so a book WITH pricing
 * wins a point-tie over one that only has CFBD's points-only data. */
function priceRank(price: number | null): number {
  return price === null ? -Infinity : price;
}

export function bestSpreadSide(lines: DisplayLine[], side: "home" | "away"): BestPick | null {
  const candidates = lines
    .map((l) => ({
      bookName: l.bookName,
      point: side === "home" ? l.homeSpread : l.awaySpread,
      price: side === "home" ? l.homeSpreadPrice : l.awaySpreadPrice,
    }))
    .filter((c): c is BestPick & { point: number } => c.point !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => {
    if (c.point > best.point!) return c;
    if (c.point < best.point!) return best;
    return priceRank(c.price) > priceRank(best.price) ? c : best;
  });
}

export function bestTotalSide(lines: DisplayLine[], side: "over" | "under"): BestPick | null {
  const candidates = lines
    .map((l) => ({ bookName: l.bookName, point: l.total, price: side === "over" ? l.overPrice : l.underPrice }))
    .filter((c): c is BestPick & { point: number } => c.point !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => {
    const better = side === "over" ? c.point < best.point! : c.point > best.point!;
    const worse = side === "over" ? c.point > best.point! : c.point < best.point!;
    if (better) return c;
    if (worse) return best;
    return priceRank(c.price) > priceRank(best.price) ? c : best;
  });
}

export function bestMoneylineSide(lines: DisplayLine[], side: "home" | "away"): BestPick | null {
  const candidates = lines
    .map((l) => ({ bookName: l.bookName, point: null as number | null, price: side === "home" ? l.homeMoneyline : l.awayMoneyline }))
    .filter((c): c is BestPick & { price: number } => c.price !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.price > best.price! ? c : best));
}

/** "+7.5 (+100)" / "-7.5 (-110)" / "—" — bare signed number, no team name. */
export function formatSpreadCell(point: number | null, price: number | null): string {
  if (point === null) return "—";
  const p = point > 0 ? `+${point}` : `${point}`;
  const priceStr = formatPrice(price);
  return priceStr ? `${p} (${priceStr})` : p;
}

/** "o42.5 -110" / "u42.5 -110" / "—" */
export function formatTotalCell(prefix: "o" | "u", point: number | null, price: number | null): string {
  if (point === null) return "—";
  const base = `${prefix}${point.toFixed(1)}`;
  const priceStr = formatPrice(price);
  return priceStr ? `${base} ${priceStr}` : base;
}

// --- Freshness ---

/** Most recent fetchedAt across every book on a game — "how stale is what
 * we're showing right now." Null if nothing has a timestamp. */
export function mostRecentFetch(lines: DisplayLine[]): string | null {
  const times = lines.map((l) => l.fetchedAt).filter((t): t is string => t !== null);
  if (times.length === 0) return null;
  return times.reduce((latest, t) => (new Date(t) > new Date(latest) ? t : latest));
}

// --- Book disagreement ("line shopping is worth it here") ---

/** Points between the widest and narrowest home spread on the board — a
 * large gap usually means either stale data at one book or real
 * disagreement worth a second look. Spread is symmetric (home = -away), so
 * one number covers both sides. */
export function spreadDisagreement(lines: DisplayLine[]): number | null {
  const values = lines.map((l) => l.homeSpread).filter((v): v is number => v !== null);
  if (values.length < 2) return null;
  return Math.max(...values) - Math.min(...values);
}

/** Same idea for the total number itself (not the juice). */
export function totalDisagreement(lines: DisplayLine[]): number | null {
  const values = lines.map((l) => l.total).filter((v): v is number => v !== null);
  if (values.length < 2) return null;
  return Math.max(...values) - Math.min(...values);
}

export const SPREAD_WIDE_THRESHOLD = 1.5;
export const TOTAL_WIDE_THRESHOLD = 1.5;

// --- No-vig hold / arbitrage (moneyline) ---

/** American odds -> implied win probability, e.g. -110 -> 0.524, +150 -> 0.4. */
export function impliedProbability(americanOdds: number): number {
  return americanOdds < 0 ? -americanOdds / (-americanOdds + 100) : 100 / (americanOdds + 100);
}

/**
 * The book's built-in edge (vig/juice) when betting a two-way market at a
 * SINGLE book: sum of both sides' implied probabilities, minus 100% (a
 * normal book runs ~4-5% hold). Using the BEST price across different
 * books for each side instead can push this below 0% — that's a true
 * arbitrage: bet both sides at their respective best-price books for a
 * guaranteed profit regardless of outcome, vanishingly rare but worth
 * flagging when it happens.
 */
export function noVigHold(homePrice: number, awayPrice: number): number {
  return impliedProbability(homePrice) + impliedProbability(awayPrice) - 1;
}

export function moneylineHold(lines: DisplayLine[]): { holdPct: number; isArbitrage: boolean } | null {
  const home = bestMoneylineSide(lines, "home");
  const away = bestMoneylineSide(lines, "away");
  if (!home?.price || !away?.price) return null;
  const hold = noVigHold(home.price, away.price);
  return { holdPct: hold * 100, isArbitrage: hold < 0 };
}
