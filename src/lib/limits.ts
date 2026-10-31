// Pure helpers, shared by the server pages and the client Games tab (nothing here touches the database).

/** The most of a game's risk limit that may be used this far from kickoff (mirrors python/exchange/engine.py ramp). */
const RAMPS: Record<string, number[]> = {
  nfl: [0.5, 0.65, 0.75, 0.9, 1, 1, 1, 1, 1], cfb: [0.5, 0.65, 0.75, 0.9, 1, 1, 1, 1, 1],
  nba: [0.1, 0.1, 0.15, 0.2, 0.4, 0.7, 0.85, 1, 1.2], nhl: [0.1, 0.1, 0.15, 0.2, 0.4, 0.7, 0.85, 1, 1.1], cbb: [0.1, 0.1, 0.15, 0.2, 0.35, 0.6, 0.8, 1, 1],
};
const RAMP_EDGES = [120, 72, 36, 24, 12, 6, 3, 1];
/** College basketball: the factor on a game's limit from its two teams' conference tiers (AA is power v power; mirrors python/exchange/cbbtiers.py). */
export const tierMult = (tier: string | undefined | null, hours: number): number =>
  !tier ? 1 : tier === "AA" ? (hours <= 12 ? 1.5 : 1.25) : ["AB", "BB", "AC"].includes(tier) ? 1 : tier === "BC" ? 0.8 + 0.2 * Math.min(1, Math.max(0, (24 - hours) / 21)) : 0.5 + 0.5 * Math.min(1, Math.max(0, (24 - hours) / 21));
export const ramp = (hours: number, sport = ""): number => {
  const row = RAMPS[sport] ?? RAMPS.nba;
  const i = RAMP_EDGES.findIndex((e) => hours > e);
  return i < 0 ? row[row.length - 1] : row[i];
};
