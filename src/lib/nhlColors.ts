import { espnCode } from "./nhlTeams";

// Display colors per team (keyed by ESPN's team code), picked to read on this app's dark background - the real
// primaries for teams like the Kraken, Bruins or Leafs are nearly black or navy there, so those are lifted. Each team
// has a primary and a secondary; when two teams in a game look alike, the away team falls back to its secondary.
const COLORS: Record<string, [string, string]> = {
  ana: ["#F47A38", "#B9975B"], ari: ["#C8414F", "#E2D6B5"], bos: ["#FFB81C", "#A2AAAD"], buf: ["#3B6FD1", "#FCB514"],
  cgy: ["#E03A3E", "#F1BE48"], car: ["#E0262D", "#A2AAAD"], chi: ["#E03A4C", "#E6E6E6"], col: ["#A8365A", "#4A90C9"],
  cbj: ["#2E6FD0", "#E0334A"], dal: ["#1FA672", "#9AA0A6"], det: ["#E3243B", "#E5E5E5"], edm: ["#FF6A22", "#3F6FC0"],
  fla: ["#E0223F", "#B9975B"], la: ["#B5BCC0", "#6E7377"], min: ["#2E9467", "#D5354A"], mtl: ["#D8283C", "#4A5FC8"],
  nsh: ["#FFB81C", "#3F68B8"], nj: ["#E3243B", "#BEBEBE"], nyi: ["#F47D30", "#3C86D6"], nyr: ["#3B72E0", "#E3243B"],
  ott: ["#DD3446", "#C2912C"], phi: ["#FF5A1F", "#BEBEBE"], pit: ["#FCB514", "#BEBEBE"], sea: ["#7FD0D6", "#E9072B"],
  sj: ["#1BA3AC", "#EA7200"], stl: ["#3D70D0", "#FCB514"], tb: ["#3D6FD1", "#E8E8E8"], tor: ["#3F6FCB", "#E8E8E8"],
  utah: ["#71AFE5", "#BEBEBE"], van: ["#3A74C9", "#1FA766"], vgk: ["#B4975A", "#8E979C"], wsh: ["#E3243B", "#3F68B8"],
  wpg: ["#4A7FCE", "#A2AAAD"],
};

const NEUTRAL = "#9AA5B1";

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function distance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

const TOO_SIMILAR = 95;

/** Colors for a matchup. The home team keeps its primary; the away team uses its primary unless that looks too much
 * like the home team's, then its secondary, then a neutral gray - so the two sides can always be told apart. */
export function matchupColors(home: string, away: string): { home: string; away: string } {
  const h = COLORS[espnCode(home) ?? ""];
  const a = COLORS[espnCode(away) ?? ""];
  const homeColor = h?.[0] ?? "#3B82F6";
  const awayChoices = a ? [a[0], a[1], NEUTRAL] : ["#F59E0B"];
  const awayColor = awayChoices.find((c) => distance(c, homeColor) >= TOO_SIMILAR) ?? NEUTRAL;
  return { home: homeColor, away: awayColor };
}

/** A striped fill in a team's color, for "won in overtime / the shootout" next to the solid "won in regulation".
 * Stripes read as different from solid for every color, including light ones where a lighter tint would barely show. */
export function striped(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 5px, color-mix(in srgb, ${color} 40%, transparent) 5px 10px)`;
}
