import { americanToProb, fmtOdds } from "./nhlModel";

/** The slim price columns of nhl_odds_snapshots (no model digest - it is big and not needed here). */
export type MovementSnapshot = {
  game_id: number;
  captured_at: string;
  ml_home: number | null;
  ml_away: number | null;
  spread_home_line: number | null;
  spread_home_odds: number | null;
  spread_away_odds: number | null;
  total_line: number | null;
  over_odds: number | null;
  under_odds: number | null;
};

export type MovementGame = { id: number; home_team: string; away_team: string; start_date: string };

export type MoveMarket = "Moneyline" | "Puck line" | "Total";

/** One thing that changed between two consecutive saved DraftKings snapshots of a game. */
export type MoveRow = {
  key: string;
  at: string;
  gameId: number;
  startDate: string;
  home: string;
  away: string;
  market: MoveMarket;
  /** Which price/line moved, e.g. "Knights", "Over 6", "Line". */
  what: string;
  was: string;
  now: string;
  /** Change in the side's implied probability, in points (null for a line move). Positive = the side got more likely. */
  probPts: number | null;
  /** Size of the move: cents of price for a price move, the change in the number for a line move. */
  size: number;
  /** "price" moves are in cents, "line" moves in goals. */
  kind: "price" | "line";
  /** +1 / -1: up or down (probability for a price, the number itself for a line). */
  dir: 1 | -1;
};

/** American-price change in cents, counting through the +100/-100 gap as one step (-105 -> +100 is 5 cents). */
export function priceCents(a: number, b: number): number {
  let d = b - a;
  if (a < 0 && b > 0) d -= 200;
  else if (a > 0 && b < 0) d += 200;
  return d;
}

const nick = (t: string) => t.split(" ").slice(-1)[0];
const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const num = (n: number) => (n % 1 === 0 ? n.toFixed(1) : String(n));

/** Diffs every game's snapshots in time order and returns one row per changed price or line, newest first. The first snapshot
 * of a game is its opening look, not a move, so it produces nothing. */
export function buildMovements(snaps: MovementSnapshot[], games: MovementGame[]): MoveRow[] {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const byGame = new Map<number, MovementSnapshot[]>();
  for (const s of snaps) {
    const list = byGame.get(s.game_id);
    if (list) list.push(s);
    else byGame.set(s.game_id, [s]);
  }

  const out: MoveRow[] = [];
  for (const [gameId, list] of byGame) {
    const game = gameById.get(gameId);
    if (!game) continue;
    list.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const home = nick(game.home_team);
    const away = nick(game.away_team);

    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1];
      const c = list[i];
      const base = { at: c.captured_at, gameId, startDate: game.start_date, home: game.home_team, away: game.away_team };
      let n = 0;
      const add = (r: Omit<MoveRow, "key" | "at" | "gameId" | "startDate" | "home" | "away">) => out.push({ ...base, ...r, key: `${gameId}-${c.captured_at}-${n++}` });

      const price = (market: MoveMarket, what: string, a: number | null, b: number | null) => {
        if (a === null || b === null || a === b) return;
        const probPts = (americanToProb(b) - americanToProb(a)) * 100;
        add({ market, what, was: fmtOdds(a), now: fmtOdds(b), probPts, size: Math.abs(priceCents(a, b)), kind: "price", dir: probPts >= 0 ? 1 : -1 });
      };

      // moneyline
      price("Moneyline", `${home} ML`, p.ml_home, c.ml_home);
      price("Moneyline", `${away} ML`, p.ml_away, c.ml_away);

      // puck line: a moved line is one row (the odds come with it); otherwise each side's price
      if (p.spread_home_line !== null && c.spread_home_line !== null) {
        if (p.spread_home_line !== c.spread_home_line) {
          const fmt = (line: number, o: number | null) => `${home} ${fmtLine(line)}${o !== null ? ` (${fmtOdds(o)})` : ""}`;
          const d = c.spread_home_line - p.spread_home_line;
          add({ market: "Puck line", what: "Line", was: fmt(p.spread_home_line, p.spread_home_odds), now: fmt(c.spread_home_line, c.spread_home_odds), probPts: null, size: Math.abs(d), kind: "line", dir: d >= 0 ? 1 : -1 });
        } else {
          const l = c.spread_home_line;
          price("Puck line", `${home} ${fmtLine(l)}`, p.spread_home_odds, c.spread_home_odds);
          price("Puck line", `${away} ${fmtLine(-l)}`, p.spread_away_odds, c.spread_away_odds);
        }
      }

      // total: same idea
      if (p.total_line !== null && c.total_line !== null) {
        if (p.total_line !== c.total_line) {
          const fmt = (line: number, o: number | null, u: number | null) => `${num(line)}${o !== null && u !== null ? ` (o${fmtOdds(o)} / u${fmtOdds(u)})` : ""}`;
          const d = c.total_line - p.total_line;
          add({ market: "Total", what: "Line", was: fmt(p.total_line, p.over_odds, p.under_odds), now: fmt(c.total_line, c.over_odds, c.under_odds), probPts: null, size: Math.abs(d), kind: "line", dir: d >= 0 ? 1 : -1 });
        } else {
          price("Total", `Over ${num(c.total_line)}`, p.over_odds, c.over_odds);
          price("Total", `Under ${num(c.total_line)}`, p.under_odds, c.under_odds);
        }
      }
    }
  }
  return out.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
}
