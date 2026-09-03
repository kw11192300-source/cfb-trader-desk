"""
Parses a free-text Telegram message into bet fields, matched against a
specific set of candidate games (this week's board - see
log_bets_from_telegram.py). Deliberately NOT an LLM call: real money is on
the line, so this is a small, predictable token grammar with a strict
"ask for clarification rather than guess" policy on anything ambiguous -
same spirit as the rest of this project's "never trust anything
unvalidated" discipline, just applied to parsing instead of modeling.

Supported message shape (order-independent, case-insensitive, most parts
optional):
    <team name>  [spread]  <stake>u  [odds]  [book]  [model|market|both]  [ml|moneyline|over|under <total>]

Examples:
    "toledo -7.5 1u draftkings"
    "bet 1.5u ohio +8.8 fanduel model"
    "rutgers .5u"                       (no spread - falls back to that
                                          game's current market spread)
    "under 48.5 1u draftkings ohio"     (total, needs a team when >1 game live)
    "michigan ml 1u"                    (moneyline)
    "toledo -7.5 1u -120 draftkings"    (odds inferred: |value| >= 100 is
                                          never a real CFB spread/total, so
                                          it's unambiguous without a tag)
    "toledo -7.5 1u @-120 draftkings"   (explicit odds tag also works)

A team name only has to appear as a recognizable word-sequence somewhere in
the message - "toledo rockets -7.5 1u" works fine, the extra "rockets"
is just ignored, same as any other word that isn't a recognized token.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# Mirrors LogBetForm.tsx's COMMON_BOOKS - kept as a plain duplicate (tiny,
# read-only reference data) rather than a cross-language shared module.
KNOWN_BOOKS = ["draftkings", "fanduel", "betmgm", "caesars", "espn bet", "fanatics", "pinnacle", "circa", "bet365", "boomers"]

# Stake: "1u", "1.5u", ".5u", "1 unit", "0.82 units" - the decimal-only
# form needs its own branch since \d+(\.\d+)? requires a digit before the
# dot. "u(?:nits?)?" covers "u"/"unit"/"units" as the same suffix - a bare
# "u" needs \b right after it (matches team_match.py's own token-boundary
# convention) so it doesn't also swallow the "u" that starts "units".
STAKE_RE = re.compile(r"(?<![\d.])(\d+\.\d+|\.\d+|\d+)\s*(?:u\b|units?\b)")

# Explicit odds tags. Deliberately using (?<!\S) rather than \b right before
# an optional sign - \b only fires on a \w/\W transition, and "-" is itself
# \W, so \b before "[+-]?" silently fails to include the sign whenever it's
# preceded by whitespace (which is always, in practice). (?<!\S) just means
# "start of string or preceded by whitespace", sign-agnostic.
ODDS_PREFIX_RE = re.compile(r"(?:@|(?<!\S)odds)\s*([+-]?\d{2,4})(?!\d)")
ODDS_SUFFIX_RE = re.compile(r"(?<!\S)([+-]?\d{2,4})\s*odds\b")

NUMBER_RE = re.compile(r"(?<![\w.])[+-]?\d+(?:\.\d+)?")

# American odds are never realistically under 100 in magnitude; a CFB
# spread/total realistically never reaches 100 (the widest real spread seen
# in this project's own data is -50.5). So an unlabeled bare number >= 100
# with no decimal point is unambiguously odds, not a line - lets
# "toledo -7.5 1u -120 draftkings" work without an explicit @/odds tag.
ODDS_MAGNITUDE_THRESHOLD = 100


def _normalize(s: str) -> str:
    """Unlike cfbd_ingest/team_match.py's _normalize (which this is
    deliberately NOT reusing), this must NOT touch '-' or '.' - they're
    load-bearing for spread numbers like "-7.5", not just team-name
    punctuation. Stripping them silently turned "-7.5" into "7 5" (dropping
    both the sign and the decimal point) before this was caught."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower().strip().replace("'", "")
    s = re.sub(r"[()&]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


@dataclass
class Candidate:
    """One game the message could be about - the caller (which has DB
    access) builds this list from the current week's board."""

    game_id: int
    home_team: str
    away_team: str
    home_market_spread: float | None  # for a spread bet with no line given, default to the current market number
    total: float | None  # for a total bet with no line given


@dataclass
class ParsedBet:
    game_id: int
    side: str  # team name, or "over"/"under"
    market: str  # "spread" | "total" | "moneyline"
    line: float
    stake: float
    odds: int
    sportsbook: str | None
    edge_source: str | None  # None means "let the caller decide the default"


def _find_team(text: str, candidates: list[Candidate]) -> tuple[Candidate, bool] | None:
    """Longest-name-wins substring match, same heuristic as
    cfbd_ingest/team_match.py uses for cross-provider name matching.
    Returns (candidate, is_home) or None if no team name appears in text."""
    best: tuple[Candidate, bool, int] | None = None  # (candidate, is_home, matched_len)
    for c in candidates:
        for name, is_home in ((c.home_team, True), (c.away_team, False)):
            norm_name = _normalize(name)
            if not norm_name:
                continue
            pattern = r"\b" + re.escape(norm_name) + r"\b"
            if re.search(pattern, text):
                if best is None or len(norm_name) > best[2]:
                    best = (c, is_home, len(norm_name))
    if best is None:
        return None
    return best[0], best[1]


def _extract_odds(text: str) -> tuple[int | None, str]:
    """Returns (odds or None, text with the matched odds substring removed)
    so a tagged/inferred odds number never leaks through as the spread or
    total line afterward."""
    for pattern in (ODDS_PREFIX_RE, ODDS_SUFFIX_RE):
        m = pattern.search(text)
        if m:
            return int(m.group(1)), text[: m.start()] + text[m.end() :]

    # No explicit tag - fall back to the magnitude heuristic, but only when
    # it's unambiguous (exactly one number shaped like odds).
    numbers = list(NUMBER_RE.finditer(text))
    odds_like = [m for m in numbers if "." not in m.group(0) and abs(int(m.group(0))) >= ODDS_MAGNITUDE_THRESHOLD]
    if len(odds_like) == 1:
        m = odds_like[0]
        return int(m.group(0)), text[: m.start()] + text[m.end() :]
    return None, text


def parse_bet_message(raw_text: str, candidates: list[Candidate]) -> ParsedBet | str:
    """Returns a ParsedBet on success, or a plain-English error string
    (meant to be sent straight back to the user via Telegram reply) on
    failure - ambiguity is always a failure here, never a guess."""
    text = _normalize(raw_text)

    stake_match = STAKE_RE.search(text)
    if not stake_match:
        return (
            'Missing stake - a bare number is ambiguous with the spread/odds, so I won\'t guess. '
            'Tag it explicitly: "1u", "0.5u", or "0.82 units".'
        )
    stake = float(stake_match.group(1))
    text_wo_stake = text[: stake_match.start()] + text[stake_match.end() :]

    odds, text_wo_stake_odds = _extract_odds(text_wo_stake)
    if odds is None:
        odds = -110

    sportsbook = None
    for book in KNOWN_BOOKS:
        if re.search(r"\b" + re.escape(book) + r"\b", text):
            sportsbook = book.title()
            break

    edge_source = None
    for src in ("model", "market", "both"):
        if re.search(r"\b" + src + r"\b", text):
            edge_source = src
            break

    is_moneyline = bool(re.search(r"\b(ml|moneyline)\b", text))
    is_over = bool(re.search(r"\bover\b", text))
    is_under = bool(re.search(r"\bunder\b", text))

    if is_over or is_under:
        # Total bet - no team needed. Line is the first remaining number;
        # if omitted, fall back to whatever total this week's slate is
        # showing (only sane with exactly one candidate game in play -
        # otherwise the user needs a team name to disambiguate anyway).
        numbers = NUMBER_RE.findall(text_wo_stake_odds)
        line = float(numbers[0]) if numbers else None
        if line is None:
            if len(candidates) == 1 and candidates[0].total is not None:
                line = candidates[0].total
            else:
                return "Missing total number, and I can't default one - add it explicitly, e.g. \"under 48.5 1u\"."
        game = candidates[0] if len(candidates) == 1 else None
        if game is None:
            match = _find_team(text, candidates)
            if match is None:
                return "Couldn't tell which game this total bet is for - include a team name."
            game = match[0]
        return ParsedBet(
            game_id=game.game_id,
            side="over" if is_over else "under",
            market="total",
            line=line,
            stake=stake,
            odds=odds,
            sportsbook=sportsbook,
            edge_source=edge_source,
        )

    match = _find_team(text, candidates)
    if match is None:
        return "Couldn't match a team name in your message to any game this week - check the spelling and try again."
    game, is_home = match
    side_name = game.home_team if is_home else game.away_team

    if is_moneyline:
        return ParsedBet(
            game_id=game.game_id,
            side=side_name,
            market="moneyline",
            line=0,
            stake=stake,
            odds=odds,
            sportsbook=sportsbook,
            edge_source=edge_source,
        )

    # Spread bet (default market). Line = first number left after removing
    # the team name, stake, and any odds - or the current market number for
    # that side if none was given.
    text_wo_team = re.sub(r"\b" + re.escape(_normalize(side_name)) + r"\b", " ", text_wo_stake_odds)
    numbers = NUMBER_RE.findall(text_wo_team)
    if numbers:
        line = float(numbers[0])
    elif game.home_market_spread is not None:
        line = game.home_market_spread if is_home else -game.home_market_spread
    else:
        return f"No spread given and no current market line on file for {side_name} - add one explicitly, e.g. \"-7.5\"."

    return ParsedBet(
        game_id=game.game_id,
        side=side_name,
        market="spread",
        line=line,
        stake=stake,
        odds=odds,
        sportsbook=sportsbook,
        edge_source=edge_source,
    )
