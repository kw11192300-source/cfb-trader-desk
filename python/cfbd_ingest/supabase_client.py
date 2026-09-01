from supabase import Client, create_client

from .config import SUPABASE_SECRET_KEY, SUPABASE_URL

_client: Client | None = None


def get_client() -> Client:
    global _client
    if _client is None:
        if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
            raise RuntimeError("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in .env.local")
        # Server-side only: the secret key bypasses RLS, never ship it to the browser.
        _client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
    return _client


# Primary/near-unique key columns per table, used to make paginated reads
# deterministic (see fetch_all's docstring for why this matters).
_TABLE_ORDER_KEYS: dict[str, list[str]] = {
    "teams": ["id"],
    "games": ["id"],
    "betting_lines": ["game_id", "provider"],
    "line_snapshots": ["id"],
    "team_season_stats": ["season", "team_id"],
    "team_game_stats": ["game_id", "team_id"],
    "team_ratings": ["season", "team_id", "source", "week"],
    "team_talent": ["season", "team_id"],
    "team_returning_production": ["season", "team_id"],
    "player_transfers": ["id"],
    "predictions": ["game_id", "model_version"],
    "odds_api_lines": ["game_id", "bookmaker"],
    "team_coaching": ["season", "team_id"],
    "team_game_boxscore": ["game_id", "team_id"],
}


def fetch_all(table: str, select: str = "*", page_size: int = 1000, **filters) -> list[dict]:
    """Reads every row from a table, paginating past Supabase's default
    1000-row-per-request cap. Two failure modes this specifically guards
    against:
      1. Without pagination at all, `.select(...).execute()` on any table
         over 1000 rows (teams has ~1,930) silently truncates.
      2. Pagination via `.range()` WITHOUT an explicit `.order()` has no
         guaranteed stable row order between separate requests (Postgres
         makes no ordering promise without ORDER BY) — successive pages can
         overlap or skip rows entirely. Caught live: team_ratings paginated
         without ordering returned 84 sp_plus/2022 rows via one path and
         131 via a directly-filtered query for the exact same data.
    `filters` are passed as `.eq(key, value)` for each kwarg, applied
    before pagination. Ordering uses each table's primary/near-unique key
    from _TABLE_ORDER_KEYS; add new tables there as fetch_all is used on them.
    """
    if table not in _TABLE_ORDER_KEYS:
        raise ValueError(f"fetch_all({table!r}): no order key registered in _TABLE_ORDER_KEYS - pagination would be unsafe without one.")
    client = get_client()
    rows: list[dict] = []
    page = 0
    while True:
        q = client.table(table).select(select)
        for key, value in filters.items():
            q = q.eq(key, value)
        for col in _TABLE_ORDER_KEYS[table]:
            q = q.order(col)
        batch = q.range(page * page_size, page * page_size + page_size - 1).execute().data
        rows.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return rows
