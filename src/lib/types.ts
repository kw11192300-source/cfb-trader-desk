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

/** A game joined with its chosen betting line (see pickLine) and both teams' logos. */
export type BoardRow = {
  game: Game;
  line: BettingLine | null;
  homeLogo: string | null;
  awayLogo: string | null;
};
