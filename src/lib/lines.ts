import type { BettingLine } from "./types";

/**
 * Picks a single line per game from however many sportsbooks CFBD returned:
 * prefers DraftKings (CFBD spells this two ways historically — "DraftKings"
 * and "Draft Kings" — so match loosely), then falls back to whichever book
 * has a value. Mirrors the sibling CFB Pick 'Em app's pickSpread
 * (../CFB Pick Em/src/lib/cfbd.ts) so both apps favor the same book.
 */
export function pickLine(lines: BettingLine[]): BettingLine | null {
  if (lines.length === 0) return null;
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const draftKings = lines.find((l) => normalize(l.provider) === "draftkings" && l.spread !== null);
  const consensus = lines.find((l) => normalize(l.provider) === "consensus" && l.spread !== null);
  const anyWithSpread = lines.find((l) => l.spread !== null);
  return draftKings ?? consensus ?? anyWithSpread ?? lines[0];
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
