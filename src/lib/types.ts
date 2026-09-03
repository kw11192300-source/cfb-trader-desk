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

/** A game joined with every book's line for it (both providers), both teams'
 * logos, and the model's own prediction for it if one exists (most weeks
 * this is null - only week-1 FBS-vs-FBS games have a live prediction right
 * now; see predict_week1.py). */
export type BoardRow = {
  game: Game;
  lines: BettingLine[];
  oddsApiLines: OddsApiLine[];
  homeLogo: string | null;
  awayLogo: string | null;
  prediction: Prediction | null;
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

/** CFB Trader Desk's own power rating (python/modeling/power_rating.py) — current-week snapshot, one row per team. */
export type TeamPowerRating = {
  season: number;
  week: number;
  team_id: number;
  team: string;
  classification: string | null;
  scoring_off: number | null;
  scoring_def: number | null;
  overall: number | null;
  efficiency_off: number | null;
  efficiency_def: number | null;
  updated_at: string;
};

/** A model's prediction for one game (python/modeling/predict_week1.py and
 * future predict_week.py writers) — see predictions in schema.sql.
 * predicted_home_win_prob/predicted_total/predicted_clv_* are populated by
 * other model versions this table anticipates, not predict_week1.py (margin
 * only), so stay nullable here. */
export type Prediction = {
  game_id: number;
  model_version: string;
  predicted_home_win_prob: number | null;
  predicted_margin: number | null;
  predicted_total: number | null;
  market_spread: number | null;
  market_total: number | null;
  edge_spread: number | null;
  edge_total: number | null;
  predicted_clv_move: number | null;
  predicted_clv_direction: string | null;
  rationale: string | null;
  suggested_units: number | null;
  created_at: string;
};

/** One individual graded game from the same backtest run (python/modeling/
 * backtest_week1.py) - every week-1 game 2016-2025, all matchup types, not
 * just the FBS-vs-FBS top-15 pool model_backtests summarizes. is_selected
 * flags whether it was in that season's top-15-by-edge pool for its own
 * matchup type. */
export type ModelBacktestGame = {
  id: number;
  model_version: string;
  season: number;
  home_team: string;
  away_team: string;
  market_spread: number;
  predicted_margin: number;
  edge: number;
  matchup_type: string;
  pick_team: string;
  actual_margin: number;
  correct: boolean;
  is_selected: boolean;
  rationale: string | null;
  computed_at: string;
};

/** One stored walk-forward backtest row (python/modeling/backtest_week1.py)
 * — general shape (group_key + label rows) rather than one column per
 * breakdown, since which breakdowns get computed will keep changing. */
export type ModelBacktest = {
  id: number;
  model_version: string;
  group_key: string;
  label: string;
  n: number;
  win_rate: number;
  sort_order: number;
  computed_at: string;
};

/** A real bet actually placed - written from the Next.js app itself (a
 * Server Action, secret key never reaches the browser), not the Python
 * ingestion scripts. See bets in schema.sql. Win/loss/push/profit are
 * never stored - always computed live against the game's current state,
 * so a graded result can never go stale. */
export type Bet = {
  id: number;
  game_id: number;
  model_version: string | null;
  market: "spread" | "total" | "moneyline" | string;
  side: string; // team name (spread/moneyline) or "over"/"under" (total)
  line: number; // bettor's own side, spread convention (negative = favored)
  odds: number; // american odds actually taken
  stake: number;
  sportsbook: string | null; // free text - not every book is in Odds API/CFBD coverage
  edge_source: "model" | "market" | "both"; // what justified the bet - see schema.sql
  placed_at: string;
  notes: string | null;
  created_at: string;
};

/** One team's season-long projection (python/modeling/season_sim.py) -
 * Monte Carlo simulation of the rest of the season built on power ratings,
 * NOT the validated week-1 spread model (that model is scoped to single
 * week-1 games, not chained season-long). EXPLORATORY/UNVALIDATED - no
 * backtest exists yet against real past seasons, unlike everything on the
 * Edges/Backtest pages. See season_sim.py's module docstring. */
export type SeasonFuture = {
  team: string;
  season: number;
  model_version: string;
  games_remaining: number;
  proj_wins: number;
  win_total_std: number;
  playoff_prob: number;
  championship_prob: number;
  market_championship_prob: number | null;
  edge: number | null;
  computed_at: string;
};
