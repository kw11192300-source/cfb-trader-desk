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


def fetch_all(table: str, select: str = "*", page_size: int = 1000, **filters) -> list[dict]:
    """Reads every row from a table, paginating past Supabase's default
    1000-row-per-request cap. Without this, `.select(...).execute()` on any
    table bigger than 1000 rows (teams has ~1,930) silently truncates —
    which order gets kept isn't documented, so a query for e.g. "Michigan"
    can just be missing depending on where it landed. `filters` are passed
    as `.eq(key, value)` for each kwarg, applied before pagination.
    """
    client = get_client()
    rows: list[dict] = []
    page = 0
    while True:
        q = client.table(table).select(select)
        for key, value in filters.items():
            q = q.eq(key, value)
        batch = q.range(page * page_size, page * page_size + page_size - 1).execute().data
        rows.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return rows
