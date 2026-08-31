"""
Matches The Odds API's team names (full mascot names, e.g. "Rutgers Scarlet
Knights") against CFBD's plain school names (e.g. "Rutgers") already in our
`games` table. There's no shared ID between the two providers, so this is
the only way to link an Odds API event to one of our games.

Strategy: longest word-boundary prefix match, with a small alias table for
schools where the two providers use genuinely different names (not just
"school vs school+mascot") — e.g. CFBD's "UAlbany" shows up in Odds API as
just "Albany". Longest-prefix (not first-match) matters because several
CFBD names share a prefix with an unrelated, more specific school — e.g.
CFBD "North Carolina" is *also* a valid prefix of Odds API's "North
Carolina A&T Aggies", which is really a different school (CFBD "North
Carolina A&T"); picking the longest candidate resolves that correctly.

This is intentionally conservative: an odds-api event only resolves to a
game if BOTH home and away teams match AND kickoff times line up within a
few hours. A miss just means that game doesn't get Odds API pricing this
run — the site still has CFBD's data as a fallback — rather than risking a
wrong pairing writing bad data.
"""
from __future__ import annotations

import datetime
import re
import unicodedata

# CFBD school name -> the name The Odds API actually uses for it, where the
# two genuinely diverge beyond "school" vs "school + mascot". Add to this as
# more mismatches turn up (a school silently going unmatched is the failure
# mode, not a wrong match, so this is safe to extend incrementally).
ALIASES: dict[str, str] = {
    "UAlbany": "Albany",
    "Long Island University": "LIU",
    "Youngstown State": "Youngstown St",
    "Massachusetts": "UMass",
    "The Citadel": "Citadel",
    "Houston Christian": "Houston Baptist",  # Odds API hasn't picked up the rebrand
    "SE Louisiana": "Southeastern Louisiana",
    "App State": "Appalachian State",
    "Southern Miss": "Southern Mississippi",  # "Southern Miss" IS a char-prefix of
    # "Southern Mississippi" but fails the word-boundary check (continues
    # mid-word into "-issippi"), so it needs an explicit alias despite looking
    # like it should just work.
    # Verified against live CFBD team names; matched fine without an alias:
    # "Sam Houston" (Odds API also just says "Sam Houston").
}

# A bit more forgiving than CFBD-vs-CFBD comparisons need, because the two
# providers can genuinely disagree on kickoff time for games more than a
# few weeks out — TV scheduling isn't final yet, and each source updates on
# its own timeline. Same-day mismatches still get caught; multi-hour or
# multi-day disagreements (seen on games 5+ weeks out) just don't match
# until both sources converge, which happens naturally on a later sync run.
KICKOFF_TOLERANCE = datetime.timedelta(hours=6)


def _normalize(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")  # é -> e, etc.
    s = s.lower().strip().replace("'", "")  # drop apostrophes entirely, not as a word break
    s = re.sub(r"[().&-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _is_prefix_match(candidate: str, full_name: str) -> bool:
    """True if `candidate` matches `full_name` at a word boundary — i.e.
    full_name starts with candidate, and the next character (if any) starts
    a new word rather than continuing the same one."""
    c, f = _normalize(candidate), _normalize(full_name)
    if not f.startswith(c):
        return False
    return len(f) == len(c) or f[len(c)] == " "


def find_best_school_match(odds_team_name: str, cfbd_schools: list[str]) -> str | None:
    """Among cfbd_schools, returns the longest one that's a prefix match for
    odds_team_name (checking both the raw name and its alias, if any)."""
    candidates = []
    for school in cfbd_schools:
        alias = ALIASES.get(school)
        if _is_prefix_match(school, odds_team_name) or (alias and _is_prefix_match(alias, odds_team_name)):
            candidates.append(school)
    if not candidates:
        return None
    return max(candidates, key=len)


def match_odds_events_to_games(
    events: list[dict], games: list[dict]
) -> dict[str, int]:
    """Returns {odds_api_event_id: our_game_id} for every event that could be
    confidently matched. `games` rows need at least: id, home_team,
    away_team, start_date."""
    cfbd_schools = list({g["home_team"] for g in games} | {g["away_team"] for g in games})

    # Index games by (home_school, away_school) for fast lookup once both
    # sides' odds-api names have been resolved to CFBD school names.
    games_by_pair: dict[tuple[str, str], list[dict]] = {}
    for g in games:
        key = (g["home_team"], g["away_team"])
        games_by_pair.setdefault(key, []).append(g)

    matches: dict[str, int] = {}
    for event in events:
        home_school = find_best_school_match(event["home_team"], cfbd_schools)
        away_school = find_best_school_match(event["away_team"], cfbd_schools)
        if home_school is None or away_school is None:
            continue
        candidates = games_by_pair.get((home_school, away_school), [])
        if not candidates:
            continue
        event_time = datetime.datetime.fromisoformat(event["commence_time"].replace("Z", "+00:00"))
        for g in candidates:
            game_time = datetime.datetime.fromisoformat(g["start_date"].replace("Z", "+00:00"))
            if abs(event_time - game_time) <= KICKOFF_TOLERANCE:
                matches[event["id"]] = g["id"]
                break
    return matches
