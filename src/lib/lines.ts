import type { BettingLine } from "./types";

/** Books currently live in CFBD's feed, in display order. Anything else
 * (older regional variants, "consensus", or non-book model projections like
 * numberfire/teamrankings) still renders — this only controls sort order and
 * the "trusted books" label; it's not a filter. */
const KNOWN_BOOK_ORDER = ["DraftKings", "ESPN Bet", "Bovada", "Caesars", "William Hill", "consensus"];

const MODEL_PROVIDERS = new Set(["numberfire", "teamrankings"]);

/**
 * Collapses CFBD's historical provider-name variants down to one canonical
 * name per book for display — e.g. "Draft Kings" and "DraftKings" are the
 * same book, "Caesars (Pennsylvania)" and "Caesars Sportsbook (Colorado)"
 * are both just "Caesars". Raw provider strings are left untouched in the
 * database; this only affects what's shown.
 */
export function normalizeProviderName(provider: string): string {
  const p = provider.trim();
  if (/^draft ?kings$/i.test(p)) return "DraftKings";
  if (/^caesars/i.test(p)) return "Caesars";
  if (/^william hill/i.test(p)) return "William Hill";
  return p;
}

export function isModelProjection(provider: string): boolean {
  return MODEL_PROVIDERS.has(provider.toLowerCase());
}

/** Real sportsbook lines only — excludes numberfire/teamrankings power-rating projections. */
export function realBookLines(lines: BettingLine[]): BettingLine[] {
  return lines.filter((l) => !isModelProjection(l.provider));
}

/** Sorts lines with known live books first (DraftKings, ESPN Bet, Bovada, ...), then everything else. */
export function sortLines(lines: BettingLine[]): BettingLine[] {
  const rank = (l: BettingLine) => {
    const i = KNOWN_BOOK_ORDER.indexOf(normalizeProviderName(l.provider));
    return i === -1 ? KNOWN_BOOK_ORDER.length : i;
  };
  return [...lines].sort((a, b) => rank(a) - rank(b));
}

/**
 * Picks one line to headline a game card: prefers DraftKings, then whatever
 * real book has a value, then falls back to a model projection rather than
 * showing nothing. Mirrors the sibling CFB Pick 'Em app's pickSpread
 * (../CFB Pick Em/src/lib/cfbd.ts) in spirit, generalized to any book set.
 */
export function pickHeadlineLine(lines: BettingLine[]): BettingLine | null {
  if (lines.length === 0) return null;
  const real = realBookLines(lines);
  const draftKings = real.find((l) => normalizeProviderName(l.provider) === "DraftKings" && l.spread !== null);
  const anyReal = real.find((l) => l.spread !== null);
  const anyAtAll = lines.find((l) => l.spread !== null);
  return draftKings ?? anyReal ?? anyAtAll ?? lines[0];
}

/** Renders a spread the way sportsbooks conventionally do, e.g. "TCU -7.5". */
export function formatSpread(homeTeam: string, awayTeam: string, spread: number | null): string {
  if (spread === null) return "—";
  if (spread === 0) return "Pick 'em";
  return spread < 0 ? `${homeTeam} ${spread}` : `${awayTeam} -${spread}`;
}

export type Movement = { delta: number; direction: "up" | "down" | "flat" };

/** Positive delta = line moved toward the home team (more negative spread). */
export function spreadMovement(line: BettingLine): Movement | null {
  if (line.spread === null || line.spread_open === null) return null;
  const delta = line.spread_open - line.spread; // open minus current: positive = moved toward home
  if (delta === 0) return { delta, direction: "flat" };
  return { delta, direction: delta > 0 ? "down" : "up" }; // "down" = spread number went down = home favored more
}

export function totalMovement(line: BettingLine): Movement | null {
  if (line.over_under === null || line.over_under_open === null) return null;
  const delta = line.over_under - line.over_under_open;
  if (delta === 0) return { delta, direction: "flat" };
  return { delta, direction: delta > 0 ? "up" : "down" };
}

export function formatMoneyline(ml: number | null): string {
  if (ml === null) return "—";
  return ml > 0 ? `+${ml}` : `${ml}`;
}

/** The best (most favorable to a bettor) spread number across books, home-team perspective. */
export function bestSpread(lines: BettingLine[], side: "home" | "away"): BettingLine | null {
  const withSpread = realBookLines(lines).filter((l) => l.spread !== null);
  if (withSpread.length === 0) return null;
  // Home perspective: more positive (or less negative) is better for home. Away is the mirror.
  return withSpread.reduce((best, l) => {
    const better = side === "home" ? l.spread! > best.spread! : -l.spread! > -best.spread!;
    return better ? l : best;
  });
}

/** The best (highest) total for an over bettor, or lowest for an under bettor. */
export function bestTotal(lines: BettingLine[], side: "over" | "under"): BettingLine | null {
  const withTotal = realBookLines(lines).filter((l) => l.over_under !== null);
  if (withTotal.length === 0) return null;
  return withTotal.reduce((best, l) => {
    const better = side === "over" ? l.over_under! > best.over_under! : l.over_under! < best.over_under!;
    return better ? l : best;
  });
}
