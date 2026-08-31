export type Team = {
  id: number;
  school: string;
  mascot: string | null;
  conference: string | null;
  classification: string | null;
  color: string | null;
  alt_color: string | null;
  logo_url: string | null;
};

export type Game = {
  id: number;
  season: number;
  week: number;
  season_type: string;
  start_date: string;
  completed: boolean;
  neutral_site: boolean;
  venue: string | null;
  home_id: number | null;
  home_team: string;
  home_conference: string | null;
  home_points: number | null;
  away_id: number | null;
  away_team: string;
  away_conference: string | null;
  away_points: number | null;
};

export type BettingLine = {
  game_id: number;
  provider: string;
  spread: number | null;
  spread_open: number | null;
  over_under: number | null;
  over_under_open: number | null;
  home_moneyline: number | null;
  away_moneyline: number | null;
  formatted_spread: string | null;
  fetched_at: string;
};

/** A single bookmaker's current line from The Odds API — has real per-side
 * juice/price and a wider book set than CFBD, but current-state only (no
 * open/historical). See odds_api_lines in schema.sql. */
export type OddsApiLine = {
  game_id: number;
  bookmaker: string;
  bookmaker_title: string;
  home_spread: number | null;
  home_spread_price: number | null;
  away_spread: number | null;
  away_spread_price: number | null;
  total: number | null;
  over_price: number | null;
  under_price: number | null;
  home_moneyline: number | null;
  away_moneyline: number | null;
  book_last_update: string | null;
  fetched_at: string;
};

/** A game joined with every book's line for it (both providers) and both teams' logos. */
export type BoardRow = {
  game: Game;
  lines: BettingLine[];
  oddsApiLines: OddsApiLine[];
  homeLogo: string | null;
  awayLogo: string | null;
};

/** One poll_lines.py capture — append-only, never overwritten. See line_snapshots in schema.sql. */
export type LineSnapshot = {
  game_id: number;
  provider: string;
  spread: number | null;
  over_under: number | null;
  home_moneyline: number | null;
  away_moneyline: number | null;
  captured_at: string;
};
