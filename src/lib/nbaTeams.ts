// The 30 NBA teams by ESPN display name -> the abbreviation ESPN's logo CDN uses. The games table stores only the display name,
// so this is how the board finds a logo. Anything not listed just shows no logo.
const ABBR: Record<string, string> = {
  "Atlanta Hawks": "atl",
  "Boston Celtics": "bos",
  "Brooklyn Nets": "bkn",
  "Charlotte Hornets": "cha",
  "Chicago Bulls": "chi",
  "Cleveland Cavaliers": "cle",
  "Dallas Mavericks": "dal",
  "Denver Nuggets": "den",
  "Detroit Pistons": "det",
  "Golden State Warriors": "gs",
  "Houston Rockets": "hou",
  "Indiana Pacers": "ind",
  "LA Clippers": "lac",
  "Los Angeles Lakers": "lal",
  "Memphis Grizzlies": "mem",
  "Miami Heat": "mia",
  "Milwaukee Bucks": "mil",
  "Minnesota Timberwolves": "min",
  "New Orleans Pelicans": "no",
  "New York Knicks": "ny",
  "Oklahoma City Thunder": "okc",
  "Orlando Magic": "orl",
  "Philadelphia 76ers": "phi",
  "Phoenix Suns": "phx",
  "Portland Trail Blazers": "por",
  "Sacramento Kings": "sac",
  "San Antonio Spurs": "sa",
  "Toronto Raptors": "tor",
  "Utah Jazz": "utah",
  "Washington Wizards": "wsh",
};

export function nbaLogo(team: string): string | null {
  const a = ABBR[team];
  return a ? `https://a.espncdn.com/i/teamlogos/nba/500/${a}.png` : null;
}

/** "Boston Celtics" -> "Celtics" (the last word, except the two-word nicknames). */
export function nbaShort(team: string): string {
  if (team.endsWith("Trail Blazers")) return "Trail Blazers";
  const parts = team.split(" ");
  return parts[parts.length - 1];
}

/** games.id = -(ESPN event id + this): a distinct range from NFL, NHL, CBB and CFB. */
export const NBA_GAME_ID_OFFSET = 8_000_000_000;

/** A readable colour per team (picked to show on a dark background, so a few are the secondary colour). */
const COLOR: Record<string, string> = {
  "Atlanta Hawks": "#E03A3E", "Boston Celtics": "#00A651", "Brooklyn Nets": "#9AA0A6", "Charlotte Hornets": "#00A3B5", "Chicago Bulls": "#CE1141",
  "Cleveland Cavaliers": "#B5304F", "Dallas Mavericks": "#0F6FC6", "Denver Nuggets": "#FEC524", "Detroit Pistons": "#D5223E", "Golden State Warriors": "#FDB927",
  "Houston Rockets": "#CE1141", "Indiana Pacers": "#FDBB30", "LA Clippers": "#C8102E", "Los Angeles Lakers": "#FDB927", "Memphis Grizzlies": "#5D76A9",
  "Miami Heat": "#D0183F", "Milwaukee Bucks": "#3B9E5B", "Minnesota Timberwolves": "#3A8FD0", "New Orleans Pelicans": "#C8A96A", "New York Knicks": "#F58426",
  "Oklahoma City Thunder": "#007AC1", "Orlando Magic": "#0077C0", "Philadelphia 76ers": "#1E6FD9", "Phoenix Suns": "#E56020", "Portland Trail Blazers": "#E03A3E",
  "Sacramento Kings": "#8D5FD3", "San Antonio Spurs": "#C4CED4", "Toronto Raptors": "#CE1141", "Utah Jazz": "#9B6BFF", "Washington Wizards": "#E31837",
};

/** The two teams' colours for a split bar; if they are the same, the home side goes neutral grey so the halves stay distinguishable. */
export function nbaMatchupColors(away: string, home: string): { away: string; home: string } {
  const a = COLOR[away] ?? "#6b7280";
  const h = COLOR[home] ?? "#9ca3af";
  return { away: a, home: h.toLowerCase() === a.toLowerCase() ? "#8892a0" : h };
}
