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
