/** Which team a spread or moneyline bet is on. College basketball bets are logged with the school's short name ("High Point") while the game
 * carries the full team name ("High Point Panthers"), so a plain equality test sent every such bet to the road team and graded it against
 * the wrong side. This accepts an exact match first, then a match where one name begins with the other ("High Point" and "High Point Panthers"),
 * and returns null when neither team fits. Other sports log the full team name, which still matches exactly. */
const norm = (s: string): string => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export function betSideTeam(side: string, game: { home_team: string; away_team: string }): "home" | "away" | null {
  if (side === game.home_team) return "home";
  if (side === game.away_team) return "away";
  const s = norm(side), h = norm(game.home_team), a = norm(game.away_team);
  const fit = (t: string) => (s === t ? 3 : t.startsWith(`${s} `) || s.startsWith(`${t} `) ? 2 : 0);
  const fh = fit(h), fa = fit(a);
  if (fh === 0 && fa === 0) return null;
  if (fh === fa) return null; // both names fit equally (two teams sharing a first word): do not guess
  return fh > fa ? "home" : "away";
}

/** True when the bet is on the home team. A bet that cannot be placed on either team counts as the road side, as before. */
export const sideIsHome = (side: string, game: { home_team: string; away_team: string }): boolean => betSideTeam(side, game) === "home";
