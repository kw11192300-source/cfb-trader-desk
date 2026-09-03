"""
Season-long futures: Monte Carlo simulation of the rest of the season using
the site's own power ratings, run thousands of times to estimate each FBS
team's probability of making the 12-team playoff and winning the national
championship - compared against real market futures odds (The Odds API's
americanfootball_ncaaf_championship_winner).

Deliberately NOT built on the validated week-1 ML outcome model
(predict_week1.py) - that model is scoped and proven specifically for
week-1-of-season spread edges, and this project already found the same
methodology does NOT transfer to later weeks. This is a different tool for
a different job: a season-long simulation built directly on the power
ratings (the same forward-looking signal behind the Ratings page), not the
spread-edge model.

READ BEFORE TRUSTING THESE NUMBERS FOR REAL MONEY: this is exploratory and
UNVALIDATED. The playoff field is a simplified proxy - the highest-rated
team in each conference stands in for "conference champion" (no actual
championship games or tiebreakers simulated), and ranking is by simulated
final rating, not a real committee's judgment. No backtest exists yet
against real past seasons' actual outcomes. Treat this as directional
context, not a betting signal, until it's been checked against 2022-2025
the same way every other strategy on this site has been.

Calibration:
  HFA = 2.53, SIGMA = 14.78 - both fit empirically from 2022-2025 completed
  FBS games via market_rating.py's fit_massey_ratings (actual margin as
  the regression target, home-field as a fitted dummy). In line with
  published values (CFB HFA is usually cited around 2-3 points; SIGMA is
  in the same range public systems like SP+/FPI use).
  STARTING_RATING_UNCERTAINTY and ELO_K are judgment calls, not
  empirically fit - a real calibration would need a historical study of
  preseason-rating accuracy against how seasons actually unfolded.
  Reasonable defaults; worth revisiting once this season's real results
  accumulate.

Usage:
    python -m modeling.season_sim
"""
from __future__ import annotations

import datetime

import numpy as np
import pandas as pd
import requests
from scipy.stats import norm

from cfbd_ingest.config import ODDS_API_KEY
from cfbd_ingest.supabase_client import get_client
from cfbd_ingest.team_match import find_best_school_match

MODEL_VERSION = "season_sim_v1"

HFA = 2.53
SIGMA = 14.78
STARTING_RATING_UNCERTAINTY = 4.0
ELO_K = 4.0
N_SIMS = 5000
PLAYOFF_SIZE = 12
AUTO_BID_CHAMPS = 5
UNRATED_OPPONENT_RATING = -30.0  # well below any real FBS/FCS team - only used for the rare D2/D3/NAIA buy-game opponent with no rating at all


def _win_prob(rating_a: float, rating_b: float, neutral: bool) -> float:
    """P(team A beats team B), A at home unless neutral."""
    margin = rating_a - rating_b + (0 if neutral else HFA)
    return float(norm.cdf(margin / SIGMA))


def _load_teams_and_conferences(client) -> dict[str, str]:
    rows = client.table("teams").select("school,conference,classification").eq("classification", "fbs").execute().data
    return {r["school"]: r["conference"] for r in rows if r["conference"]}


def _load_current_ratings(client) -> dict[str, float]:
    """ALL rated teams (FBS + FCS), not just FBS - an FBS team's remaining
    schedule includes real buy games against FCS opponents, and those need
    a real rating to simulate properly rather than being dropped (dropping
    them was the bug: it silently cut ~4-6 games out of every FBS team's
    season, undercounting proj_wins for everyone, worst for the best teams
    who schedule the most cupcake buy games)."""
    rows = client.table("team_power_ratings").select("team,overall").execute().data
    return {r["team"]: r["overall"] for r in rows if r["overall"] is not None}


def _load_schedule(client, season: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (completed, remaining) - the full schedule, every
    classification. The caller (run()) is the one that filters `remaining`
    down to games involving a tracked FBS team."""
    rows = client.table("games").select(
        "id,week,season_type,home_team,away_team,home_points,away_points,completed,neutral_site"
    ).eq("season", season).execute().data
    df = pd.DataFrame(rows)
    completed = df[df["completed"]].copy()
    remaining = df[~df["completed"]].copy()
    return completed, remaining


ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard"
ESPN_MAX_WEEK = 16  # regular season only - conference championships/bowls aren't worth chasing here


def _fetch_espn_schedule_supplement(season: int, min_week: int, known_schools: list[str]) -> pd.DataFrame:
    """STOPGAP while CFBD's monthly quota is exhausted (see
    cfbd_ingest/backfill.py's backfill_games) - our own `games` table's
    schedule backfill stops at whatever week CFBD last gave us, so this
    fills in the rest of the regular season from ESPN's public
    (undocumented, no key needed) scoreboard API instead of leaving those
    weeks blank. `min_week` should be one past the last week our own table
    actually has - the caller computes that dynamically, so once a real
    CFBD backfill extends the schedule again, this naturally supplements
    less (or nothing) without needing a code change.

    Deliberately NOT written to the `games` table - ESPN's game ids have
    nothing to do with CFBD's, so inserting them for real would risk a
    genuine duplicate once CFBD's own backfill later adds the same game
    under its real id. Stays isolated to this one Python process's
    in-memory DataFrame, used only for this simulation.

    Team names come back as ESPN's full "School Mascot" style (e.g. "Ohio
    Bobcats") - matched to our own school-only names with the SAME fuzzy
    matcher already used for Odds API team names (team_match.py), since
    it's the identical kind of matching problem. An unmatched team (most
    often an FCS opponent not in `known_schools`) makes that game
    unusable and it's dropped - same shape of limitation as before, just
    a much smaller gap than a hard week-8 cutoff."""
    rows = []
    matched = unmatched = 0
    for week in range(min_week, ESPN_MAX_WEEK + 1):
        try:
            resp = requests.get(
                ESPN_SCOREBOARD_URL,
                params={"year": season, "week": week, "seasontype": 2, "groups": 80, "limit": 300},
                timeout=30,
            )
            resp.raise_for_status()
            events = resp.json().get("events", [])
        except Exception as e:
            print(f"ESPN fetch failed for week {week}: {e}")
            continue

        for e in events:
            comp = e["competitions"][0]
            competitors = comp["competitors"]
            home = next((t for t in competitors if t["homeAway"] == "home"), None)
            away = next((t for t in competitors if t["homeAway"] == "away"), None)
            if home is None or away is None:
                continue
            home_school = find_best_school_match(home["team"]["displayName"], known_schools)
            away_school = find_best_school_match(away["team"]["displayName"], known_schools)
            if home_school is None or away_school is None:
                unmatched += 1
                continue
            matched += 1
            rows.append(
                {
                    "week": week,
                    "home_team": home_school,
                    "away_team": away_school,
                    "neutral_site": bool(comp.get("neutralSite", False)),
                    "completed": False,
                }
            )
    print(f"ESPN supplement (weeks {min_week}-{ESPN_MAX_WEEK}): {matched} games matched, {unmatched} unmatched/dropped.")
    return pd.DataFrame(rows)


def _real_wins_so_far(completed: pd.DataFrame, fbs_teams: set[str]) -> dict[str, int]:
    wins: dict[str, int] = {t: 0 for t in fbs_teams}
    for _, g in completed.iterrows():
        if g["home_points"] is None or g["away_points"] is None:
            continue
        home_won = g["home_points"] > g["away_points"]
        if g["home_team"] in wins and home_won:
            wins[g["home_team"]] += 1
        if g["away_team"] in wins and not home_won:
            wins[g["away_team"]] += 1
    return wins


def _simulate_one_season(
    base_ratings: dict[str, float],
    remaining: pd.DataFrame,
    real_wins: dict[str, int],
    rng: np.random.Generator,
) -> tuple[dict[str, int], dict[str, float]]:
    """One Monte Carlo path: samples a starting-rating perturbation per
    team, then plays out `remaining` in order, nudging both teams' ratings
    after each result (Elo-style) so a simulated hot/cold streak actually
    compounds within this path, same as it would in reality."""
    ratings = {t: r + rng.normal(0, STARTING_RATING_UNCERTAINTY) for t, r in base_ratings.items()}
    wins = dict(real_wins)

    for _, g in remaining.iterrows():
        home, away = g["home_team"], g["away_team"]
        # UNRATED_OPPONENT_RATING covers the rare true gap in coverage (a
        # D2/D3/NAIA buy-game opponent - team_power_ratings covers every
        # FBS and FCS team, so this fallback almost never actually fires).
        r_home = ratings.get(home, UNRATED_OPPONENT_RATING)
        r_away = ratings.get(away, UNRATED_OPPONENT_RATING)

        p_home = _win_prob(r_home, r_away, g["neutral_site"])
        home_won = rng.random() < p_home

        if home_won:
            wins[home] = wins.get(home, 0) + 1
        else:
            wins[away] = wins.get(away, 0) + 1

        surprise = (1.0 if home_won else 0.0) - p_home
        ratings[home] = r_home + ELO_K * surprise
        ratings[away] = r_away - ELO_K * surprise

    return wins, ratings


def _select_playoff_field(final_ratings: dict[str, float], conferences: dict[str, str]) -> list[str]:
    """Returns 12 teams, seeded 1-12 (index 0 = 1 seed). Proxy selection:
    the highest-rated team in each conference is that conference's
    "champion" (no real championship game/tiebreaker simulated); the 5
    highest-rated of those get the auto-bid/bye seeds 1-4 plus a 5 seed,
    the rest of the field fills by rating among everyone else."""
    by_conf: dict[str, list[str]] = {}
    for team, conf in conferences.items():
        if team in final_ratings:
            by_conf.setdefault(conf, []).append(team)
    champs = [max(teams, key=lambda t: final_ratings[t]) for teams in by_conf.values() if teams]
    champs.sort(key=lambda t: final_ratings[t], reverse=True)

    auto_bids = champs[:AUTO_BID_CHAMPS]
    # FBS-only for the at-large pool - final_ratings now covers FCS teams
    # too (they're real potential buy-game opponents needing a rating to
    # simulate), but the CFP field itself is FBS-only, so eligibility here
    # has to come from `conferences` (built FBS-only), not final_ratings.
    remaining_pool = [t for t in conferences if t in final_ratings and t not in auto_bids]
    remaining_pool.sort(key=lambda t: final_ratings[t], reverse=True)
    at_large = remaining_pool[: PLAYOFF_SIZE - len(auto_bids)]

    field = auto_bids + at_large
    field.sort(key=lambda t: final_ratings[t], reverse=True)
    return field[:PLAYOFF_SIZE]


def _simulate_bracket(seeds: list[str], final_ratings: dict[str, float], rng: np.random.Generator) -> str:
    """Standard 12-team CFP bracket: round 1 is 5v12/6v11/7v10/8v9 (seeds
    1-4 bye), then reseed each round (highest remaining seed plays lowest
    remaining seed) through to a champion. All rounds at the higher seed's
    home field except the final - not modeled as neutral-site precisely,
    a simplification given true CFP host sites are decided by seeding math
    beyond what's worth reproducing here."""
    idx = {team: i for i, team in enumerate(seeds)}  # 0-indexed seed rank, lower = better

    def play(a: str, b: str) -> str:
        p_a = _win_prob(final_ratings[a], final_ratings[b], neutral=False)
        return a if rng.random() < p_a else b

    round1_pairs = [(seeds[4], seeds[11]), (seeds[5], seeds[10]), (seeds[6], seeds[9]), (seeds[7], seeds[8])]
    round1_winners = [play(a, b) for a, b in round1_pairs]

    qf_field = seeds[:4] + round1_winners
    qf_field.sort(key=lambda t: idx[t])
    qf_pairs = [(qf_field[0], qf_field[-1]), (qf_field[1], qf_field[-2]), (qf_field[2], qf_field[-3]), (qf_field[3], qf_field[-4])]
    qf_winners = [play(a, b) for a, b in qf_pairs]

    sf_field = sorted(qf_winners, key=lambda t: idx[t])
    sf_winner_1 = play(sf_field[0], sf_field[3])
    sf_winner_2 = play(sf_field[1], sf_field[2])

    return play(sf_winner_1, sf_winner_2)


def _fetch_market_championship_odds() -> dict[str, float]:
    """{school_name: devigged_implied_probability}. Devigged by normalizing
    the book's raw 1/decimal_odds across its full priced field to sum to 1
    - a standard way to strip the book's built-in margin so the comparison
    against a true probability is apples-to-apples."""
    if not ODDS_API_KEY:
        return {}
    resp = requests.get(
        "https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf_championship_winner/odds",
        params={"apiKey": ODDS_API_KEY, "regions": "us", "markets": "outrights"},
        timeout=30,
    )
    resp.raise_for_status()
    events = resp.json()
    if not events or not events[0].get("bookmakers"):
        return {}
    # Prefer whichever book prices the most teams - a fuller field makes a better comparison.
    best_book = max(events[0]["bookmakers"], key=lambda b: len(b["markets"][0]["outcomes"]) if b.get("markets") else 0)
    outcomes = best_book["markets"][0]["outcomes"]
    raw = {o["name"]: 1.0 / o["price"] for o in outcomes if o["price"] > 0}
    overround = sum(raw.values())
    return {name: p / overround for name, p in raw.items()} if overround > 0 else {}


def run() -> None:
    client = get_client()
    season = datetime.date.today().year

    conferences = _load_teams_and_conferences(client)
    base_ratings = _load_current_ratings(client)
    fbs_teams = set(conferences) & set(base_ratings)
    print(f"{len(fbs_teams)} FBS teams with both a conference and a current rating.")

    completed, remaining = _load_schedule(client, season)
    real_wins = _real_wins_so_far(completed, fbs_teams)
    # Every remaining game for a tracked FBS team, including buy games
    # against FCS/weaker opponents - NOT restricted to FBS-vs-FBS. Those
    # buy games are real, likely-win games that belong in each team's
    # win-total projection; dropping them (an earlier version of this did)
    # undercounted proj_wins for everyone, worst for good teams who
    # schedule the most of them.
    remaining_games = remaining[remaining["home_team"].isin(fbs_teams) | remaining["away_team"].isin(fbs_teams)]
    print(f"{len(remaining_games)} remaining games involving a tracked FBS team from our own `games` table.")

    # STOPGAP (see _fetch_espn_schedule_supplement's docstring) - fill in
    # whatever regular-season weeks our own CFBD-backed schedule doesn't
    # have yet, from ESPN, rather than silently treating "no data past
    # week N" as "no games past week N."
    max_known_week = pd.concat([completed, remaining])["week"].max()
    max_known_week = int(max_known_week) if pd.notna(max_known_week) else 0
    if max_known_week < ESPN_MAX_WEEK:
        espn_games = _fetch_espn_schedule_supplement(season, max_known_week + 1, list(base_ratings))
        if not espn_games.empty:
            remaining_games = pd.concat([remaining_games, espn_games], ignore_index=True)
    print(f"{len(remaining_games)} total remaining games involving a tracked FBS team (own table + ESPN supplement).")

    avg_games_left = (len(remaining_games) * 2) / max(len(fbs_teams), 1)
    if avg_games_left < 9:
        print(
            f"WARNING: only ~{avg_games_left:.1f} remaining games/team on average - a full CFB season is "
            "~12-13 games. The `games` table's schedule backfill is likely incomplete for this season "
            "(check for a CFBD quota issue - see cfbd_ingest/backfill.py's backfill_games). Every number "
            "below (proj_wins especially) will be undercounted until that's fixed and re-run."
        )

    rng = np.random.default_rng(seed=42)  # fixed seed - reproducible run-to-run, not meant to hide real variance across separate runs on different days as ratings/schedule change

    win_totals: dict[str, list[int]] = {t: [] for t in fbs_teams}
    playoff_count: dict[str, int] = {t: 0 for t in fbs_teams}
    champ_count: dict[str, int] = {t: 0 for t in fbs_teams}

    for i in range(N_SIMS):
        wins, final_ratings = _simulate_one_season(base_ratings, remaining_games, real_wins, rng)
        for t in fbs_teams:
            win_totals[t].append(wins.get(t, 0))

        field = _select_playoff_field(final_ratings, conferences)
        for t in field:
            playoff_count[t] += 1
        champion = _simulate_bracket(field, final_ratings, rng)
        champ_count[champion] += 1

        if (i + 1) % 1000 == 0:
            print(f"  {i + 1}/{N_SIMS} simulations...")

    market_probs = _fetch_market_championship_odds()
    print(f"Fetched market championship odds for {len(market_probs)} teams." if market_probs else "No market championship odds available (ODDS_API_KEY unset or request failed) - proceeding model-only.")

    # One pass over the market's (full-mascot-name) field, matching each
    # against our (school-only-name) FBS list - team_match.py's own
    # direction (candidate = odds-style name, pool = our school names).
    school_by_odds_name = {name: find_best_school_match(name, list(fbs_teams)) for name in market_probs}
    market_prob_by_school = {school: market_probs[name] for name, school in school_by_odds_name.items() if school is not None}

    records = []
    for team in fbs_teams:
        totals = np.array(win_totals[team])
        model_champ_prob = champ_count[team] / N_SIMS
        market_prob = market_prob_by_school.get(team)
        edge = (model_champ_prob - market_prob) if market_prob is not None else None

        records.append(
            {
                "team": team,
                "season": season,
                "model_version": MODEL_VERSION,
                "games_remaining": int((remaining_games["home_team"] == team).sum() + (remaining_games["away_team"] == team).sum()),
                "proj_wins": float(totals.mean()),
                "win_total_std": float(totals.std()),
                "playoff_prob": playoff_count[team] / N_SIMS,
                "championship_prob": model_champ_prob,
                "market_championship_prob": market_prob,
                "edge": edge,
            }
        )

    for i in range(0, len(records), 500):
        client.table("season_futures").upsert(records[i : i + 500], on_conflict="team,season,model_version").execute()
    print(f"Upserted {len(records)} team-season futures rows (model_version={MODEL_VERSION}).")

    top = sorted(records, key=lambda r: r["championship_prob"], reverse=True)[:10]
    print("\n=== Top 10 by model championship probability ===")
    for r in top:
        mkt = f"{r['market_championship_prob']:.1%}" if r["market_championship_prob"] is not None else "  n/a"
        print(f"{r['team']:24s} model={r['championship_prob']:.1%}  market={mkt}  playoff={r['playoff_prob']:.1%}  proj_wins={r['proj_wins']:.1f}")


if __name__ == "__main__":
    run()
