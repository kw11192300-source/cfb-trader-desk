import { devig, fmtOdds } from "./nhlModel";

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

/** One side of a market, before and after. */
export type MoveSide = { label: string; was: string; now: string };

/** One market of one game that changed between two consecutive saved DraftKings snapshots - both sides together. */
export type MoveRow = {
  key: string;
  at: string;
  gameId: number;
  startDate: string;
  home: string;
  away: string;
  market: MoveMarket;
  /** A price move (the odds shifted) or a line move (the number itself changed). */
  kind: "price" | "line";
  /** Which side the market moved toward; `team` is set when it is a team (for the logo). */
  toward: { label: string; team: string | null };
  /** Both sides, in game order (away first). */
  sides: MoveSide[];
  /** Price moves: how far the no-vig probability shifted toward that side, in points. Null for line moves. */
  pts: number | null;
  /** Price moves: the biggest price change on either side, in cents. Line moves: the change in the number. */
  size: number;
  /** Total line moves are "up" / "down" (colored); everything else is neutral. */
  tone: "up" | "down" | "neutral";
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
const at = (line: number, odds: number | null, f: (n: number) => string) => `${f(line)}${odds !== null ? ` @ ${fmtOdds(odds)}` : ""}`;

/** Diffs every game's snapshots in time order and returns one row per changed market (both sides together), newest first. The
 * first snapshot of a game is its opening look, not a move, so it produces nothing. */
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
      let n = 0;
      const add = (r: Omit<MoveRow, "key" | "at" | "gameId" | "startDate" | "home" | "away">) =>
        out.push({ ...r, key: `${gameId}-${c.captured_at}-${n++}`, at: c.captured_at, gameId, startDate: game.start_date, home: game.home_team, away: game.away_team });

      /** Two-way price market where both sides' prices are comparable: who it moved toward, by how much. */
      const twoWay = (
        market: MoveMarket,
        pa: number | null, // previous price, first side (away / over)
        pb: number | null, // previous price, second side (home / under)
        ca: number | null,
        cb: number | null,
        awayLabel: string,
        homeLabel: string,
        awayTeam: string | null,
        homeTeam: string | null,
      ) => {
        if (pa === null || pb === null || ca === null || cb === null) return;
        if (pa === ca && pb === cb) return;
        const before = devig(pb, pa); // fair probability of the second side
        const after = devig(cb, ca);
        const d = (after - before) * 100;
        const size = Math.max(Math.abs(priceCents(pa, ca)), Math.abs(priceCents(pb, cb)));
        const quiet = Math.abs(d) < 0.05;
        const homeWay = d > 0;
        add({
          market,
          kind: "price",
          toward: quiet ? { label: "Neither (juice only)", team: null } : homeWay ? { label: homeLabel, team: homeTeam } : { label: awayLabel, team: awayTeam },
          sides: [
            { label: awayLabel, was: fmtOdds(pa), now: fmtOdds(ca) },
            { label: homeLabel, was: fmtOdds(pb), now: fmtOdds(cb) },
          ],
          pts: Math.abs(d),
          size,
          tone: "neutral",
        });
      };

      // moneyline
      twoWay("Moneyline", p.ml_away, p.ml_home, c.ml_away, c.ml_home, `${away} ML`, `${home} ML`, game.away_team, game.home_team);

      // puck line: a moved line is one row (the odds come with it); otherwise the two prices at the same line
      if (p.spread_home_line !== null && c.spread_home_line !== null) {
        if (p.spread_home_line !== c.spread_home_line) {
          const d = c.spread_home_line - p.spread_home_line; // home line up = home gives fewer goals / gets more = market sees home weaker
          const towardHome = d < 0;
          add({
            market: "Puck line",
            kind: "line",
            toward: { label: towardHome ? home : away, team: towardHome ? game.home_team : game.away_team },
            sides: [
              { label: away, was: at(-p.spread_home_line, p.spread_away_odds, fmtLine), now: at(-c.spread_home_line, c.spread_away_odds, fmtLine) },
              { label: home, was: at(p.spread_home_line, p.spread_home_odds, fmtLine), now: at(c.spread_home_line, c.spread_home_odds, fmtLine) },
            ],
            pts: null,
            size: Math.abs(d),
            tone: "neutral",
          });
        } else {
          const l = c.spread_home_line;
          twoWay("Puck line", p.spread_away_odds, p.spread_home_odds, c.spread_away_odds, c.spread_home_odds, `${away} ${fmtLine(-l)}`, `${home} ${fmtLine(l)}`, game.away_team, game.home_team);
        }
      }

      // total: same idea
      if (p.total_line !== null && c.total_line !== null) {
        if (p.total_line !== c.total_line) {
          const d = c.total_line - p.total_line;
          add({
            market: "Total",
            kind: "line",
            toward: { label: d > 0 ? "Up (more goals)" : "Down (fewer goals)", team: null },
            sides: [
              { label: "Over", was: at(p.total_line, p.over_odds, num), now: at(c.total_line, c.over_odds, num) },
              { label: "Under", was: at(p.total_line, p.under_odds, num), now: at(c.total_line, c.under_odds, num) },
            ],
            pts: null,
            size: Math.abs(d),
            tone: d > 0 ? "up" : "down",
          });
        } else {
          const l = num(c.total_line);
          twoWay("Total", p.over_odds, p.under_odds, c.over_odds, c.under_odds, `Over ${l}`, `Under ${l}`, null, null);
        }
      }
    }
  }
  return out.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
}
