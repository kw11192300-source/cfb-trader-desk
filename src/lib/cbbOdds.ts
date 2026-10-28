import { supabaseAdmin } from "./supabase-admin";
import { latestSnapshots } from "./latestSnapshots";

// Server-only. College basketball: keeps the `games` table current (schedule, live status, finals) straight from ESPN's
// scoreboard and logs every change in the posted lines (spread, total, moneyline) to cbb_odds_snapshots - the timestamped
// history the overnight-movement study needs, which ESPN does not keep for us. Called every ~10 minutes by
// src/app/api/cron/cbb-odds/route.ts. Mirrors the NHL timer (nhlOdds.ts) on purpose.

const ESPN_CBB_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard";
const CBB_GAME_ID_OFFSET = 7_000_000_000; // games.id = -(ESPN event id + this): a distinct range from NFL, NHL and CFB
const DAYS_BACK = 1;
const DAYS_FORWARD = 7; // a week ahead, so a season opener is on the board (with our numbers) before the market has posted anything

export const num = (s: unknown): number | null => {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(String(s).replace(/^[ou]/i, "").replace("+", ""));
  return Number.isFinite(n) ? n : null;
};
export const price = (s: unknown): number | null => {
  const n = num(s);
  return n === null ? null : Math.round(n);
};

type Price = { close?: { odds?: string; line?: string }; open?: { odds?: string; line?: string } };
export type EspnOdds = {
  provider?: { name?: string };
  details?: string;
  spread?: number;
  overUnder?: number;
  homeTeamOdds?: { moneyLine?: number; spreadOdds?: number };
  awayTeamOdds?: { moneyLine?: number; spreadOdds?: number };
  moneyline?: { home?: Price; away?: Price };
  pointSpread?: { home?: Price; away?: Price };
  total?: { over?: Price; under?: Price };
};

export type CbbMarket = {
  provider: string | null;
  ml_home: number | null;
  ml_away: number | null;
  spread_home_line: number | null;
  spread_home_odds: number | null;
  spread_away_odds: number | null;
  total_line: number | null;
  over_odds: number | null;
  under_odds: number | null;
};

export const PRICE_FIELDS = ["ml_home", "ml_away", "spread_home_line", "spread_home_odds", "spread_away_odds", "total_line", "over_odds", "under_odds"] as const;
export const samePrices = (a: CbbMarket | null, b: CbbMarket): boolean => a !== null && PRICE_FIELDS.every((k) => (a[k] ?? null) === (b[k] ?? null));

/** ESPN uses two shapes for the same thing (the structured close/open one, and the older flat one); read either. */
export function parseMarket(o: EspnOdds): CbbMarket {
  const ml = o.moneyline ?? {};
  const ps = o.pointSpread ?? {};
  const tot = o.total ?? {};
  // flat shape: `spread` is already the HOME team's number (details "GS -2.5" with the Lakers at home is spread 2.5)
  const homeLine = num(ps.home?.close?.line) ?? (typeof o.spread === "number" ? o.spread : null);
  const provider = o.provider?.name ? (/draft\s*kings/i.test(o.provider.name) ? "DraftKings" : o.provider.name) : null;
  return {
    provider,
    ml_home: price(ml.home?.close?.odds) ?? price(o.homeTeamOdds?.moneyLine),
    ml_away: price(ml.away?.close?.odds) ?? price(o.awayTeamOdds?.moneyLine),
    spread_home_line: homeLine,
    spread_home_odds: price(ps.home?.close?.odds) ?? price(o.homeTeamOdds?.spreadOdds),
    spread_away_odds: price(ps.away?.close?.odds) ?? price(o.awayTeamOdds?.spreadOdds),
    total_line: num(tot.over?.close?.line) ?? (typeof o.overUnder === "number" ? o.overUnder : null),
    over_odds: price(tot.over?.close?.odds),
    under_odds: price(tot.under?.close?.odds),
  };
}

/** ESPN's own "open" line for the game (the first number its provider posted). Kept apart from the snapshot rows: the snapshot
 * table logs every change we observe, this is the single opening number, and a failure to save it must never stop logging. */
export type CbbOpen = {
  spread_home_open: number | null;
  total_open: number | null;
  ml_home_open: number | null;
  ml_away_open: number | null;
  spread_home_odds_open: number | null;
  total_odds_open: number | null;
};

export function parseOpen(o: EspnOdds): CbbOpen | null {
  const ml = o.moneyline ?? {};
  const ps = o.pointSpread ?? {};
  const tot = o.total ?? {};
  const open: CbbOpen = {
    spread_home_open: num(ps.home?.open?.line),
    total_open: num(tot.over?.open?.line),
    ml_home_open: price(ml.home?.open?.odds),
    ml_away_open: price(ml.away?.open?.odds),
    spread_home_odds_open: price(ps.home?.open?.odds),
    total_odds_open: price(tot.over?.open?.odds),
  };
  return Object.values(open).some((v) => v !== null) ? open : null;
}

type EspnEvent = {
  id: string;
  date: string;
  season?: { year?: number; type?: number };
  status?: { type?: { state?: string; completed?: boolean; shortDetail?: string }; period?: number; displayClock?: string };
  competitions?: {
    neutralSite?: boolean;
    venue?: { fullName?: string };
    odds?: EspnOdds[];
    competitors?: { homeAway?: string; score?: string; team?: { displayName?: string; abbreviation?: string } }[];
  }[];
};

/** The season's START year: the 2026-27 season is 2026 (games are played Nov-Apr, so August onward is the new season). */
function seasonOf(iso: string): number {
  const d = new Date(new Date(iso).getTime() - 8 * 3_600_000);
  return d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export type CbbUpdateResult = { ok: boolean; message: string; games: number; priced: number; moved: number; snapshots: number; live: number; final: number };

export async function updateCbbOdds(): Promise<CbbUpdateResult> {
  const fail = (message: string): CbbUpdateResult => ({ ok: false, message, games: 0, priced: 0, moved: 0, snapshots: 0, live: 0, final: 0 });
  const fetchedAt = new Date().toISOString();
  const now = Date.now();
  const days: string[] = [];
  for (let d = -DAYS_BACK; d <= DAYS_FORWARD; d++) days.push(new Date(now + d * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""));

  let events: EspnEvent[] = [];
  try {
    const boards = await Promise.all(
      days.map(async (d) => {
        const res = await fetch(`${ESPN_CBB_SCOREBOARD}?dates=${d}&groups=50&limit=400`, { cache: "no-store" });
        if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
        return (await res.json()) as { events?: EspnEvent[] };
      }),
    );
    const seen = new Set<string>();
    for (const b of boards) {
      for (const e of b.events ?? []) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }
  } catch (e) {
    return fail(`Couldn't reach ESPN: ${e instanceof Error ? e.message : "unknown error"}.`);
  }
  events = events.filter((e) => e.competitions?.[0]?.competitors?.length === 2);
  if (events.length === 0) return { ok: true, message: "No college basketball games on the board yet.", games: 0, priced: 0, moved: 0, snapshots: 0, live: 0, final: 0 };

  // ---- games table: schedule, live status, finals
  let live = 0;
  let final = 0;
  const gameRows = events.map((e) => {
    const comp = e.competitions![0];
    const home = comp.competitors!.find((c) => c.homeAway === "home");
    const away = comp.competitors!.find((c) => c.homeAway === "away");
    const state = e.status?.type?.state;
    const completed = Boolean(e.status?.type?.completed);
    const hp = home?.score !== undefined && home.score !== "" ? Number(home.score) : null;
    const ap = away?.score !== undefined && away.score !== "" ? Number(away.score) : null;
    if (state === "in") live++;
    if (completed) final++;
    const season = seasonOf(e.date);
    const anchor = Date.UTC(season, 10, 1); // Nov 1
    const week = Math.max(1, Math.floor((new Date(e.date).getTime() - anchor) / (7 * 86_400_000)) + 1);
    return {
      id: -(Number(e.id) + CBB_GAME_ID_OFFSET),
      sport: "cbb",
      season,
      week,
      season_type: e.season?.type === 3 ? "postseason" : "regular",
      start_date: e.date,
      completed,
      neutral_site: Boolean(comp.neutralSite),
      venue: comp.venue?.fullName ?? null,
      home_team: home?.team?.displayName ?? "Home",
      home_points: hp,
      away_team: away?.team?.displayName ?? "Away",
      away_points: ap,
      live_status:
        state === "in" && hp !== null && ap !== null
          ? { home_points: hp, away_points: ap, period: e.status?.period ?? null, clock: e.status?.displayClock ?? null, detail: e.status?.type?.shortDetail ?? null, updated_at: fetchedAt }
          : null,
    };
  });
  for (let i = 0; i < gameRows.length; i += 400) {
    const { error } = await supabaseAdmin.from("games").upsert(gameRows.slice(i, i + 400), { onConflict: "id" });
    if (error) return fail(`Saving games failed: ${error.message}`);
  }

  // ---- odds: every not-yet-started game with a posted line; a snapshot whenever any price moved
  const incoming = new Map<number, CbbMarket>();
  const opens: Record<string, unknown>[] = [];
  for (const e of events) {
    if (e.status?.type?.state !== "pre") continue;
    const o = e.competitions![0].odds?.[0];
    if (!o) continue;
    const m = parseMarket(o);
    const gid = -(Number(e.id) + CBB_GAME_ID_OFFSET);
    if (PRICE_FIELDS.some((k) => m[k] !== null)) incoming.set(gid, m);
    const op = parseOpen(o);
    if (op) opens.push({ game_id: gid, provider: m.provider, first_seen_at: fetchedAt, ...op });
  }
  // finished games: save ESPN's closing numbers once (the movement model's form features need each team's results vs the close)
  const closes: Record<string, unknown>[] = [];
  for (const e of events) {
    if (!e.status?.type?.completed) continue;
    const o = e.competitions![0].odds?.[0];
    if (!o) continue;
    const m = parseMarket(o);
    if (m.spread_home_line === null && m.total_line === null) continue;
    closes.push({ game_id: -(Number(e.id) + CBB_GAME_ID_OFFSET), spread_home_close: m.spread_home_line, total_close: m.total_line, ml_home_close: m.ml_home, ml_away_close: m.ml_away });
  }
  if (closes.length > 0) {
    try {
      for (let i = 0; i < closes.length; i += 400) await supabaseAdmin.from("cbb_game_opens").upsert(closes.slice(i, i + 400), { onConflict: "game_id" });
    } catch {
      /* ignore */
    }
  }
  if (opens.length > 0) {
    // first one wins (ESPN's open does not change); never let this stop the logger (the table may not exist yet)
    try {
      for (let i = 0; i < opens.length; i += 400) {
        await supabaseAdmin.from("cbb_game_opens").upsert(opens.slice(i, i + 400), { onConflict: "game_id", ignoreDuplicates: true });
      }
    } catch {
      /* ignore */
    }
  }
  if (incoming.size === 0) {
    return { ok: true, message: `${events.length} games synced; no lines posted yet.`, games: events.length, priced: 0, moved: 0, snapshots: 0, live, final };
  }

  const last = new Map<number, CbbMarket>();
  const { rows: lastRows, error: snapErr } = await latestSnapshots("cbb_odds_snapshots", [...incoming.keys()]);
  if (snapErr) {
    const missing = snapErr.code === "PGRST205" || snapErr.code === "42P01" || /does not exist|schema cache/i.test(snapErr.message);
    return {
      ok: missing, // games were saved; the table just has not been created yet
      message: missing ? `${events.length} games synced; lines not logged yet - run the cbb_odds_snapshots block in supabase/schema.sql.` : snapErr.message,
      games: events.length,
      priced: incoming.size,
      moved: 0,
      snapshots: 0,
      live,
      final,
    };
  }
  for (const [gid, s] of lastRows) last.set(gid, s as unknown as CbbMarket);

  const rows: Record<string, unknown>[] = [];
  let moved = 0;
  for (const [gid, m] of incoming) {
    const prev = last.get(gid) ?? null;
    if (samePrices(prev, m)) continue;
    if (prev) moved++;
    rows.push({ game_id: gid, captured_at: fetchedAt, ...m });
  }
  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin.from("cbb_odds_snapshots").insert(rows.slice(i, i + 500));
      if (error) return fail(`Saving odds snapshots failed: ${error.message}`);
    }
  }
  return {
    ok: true,
    message: `${events.length} games synced, ${incoming.size} priced, ${moved} moved, ${rows.length} snapshot${rows.length === 1 ? "" : "s"} saved.`,
    games: events.length,
    priced: incoming.size,
    moved,
    snapshots: rows.length,
    live,
    final,
  };
}
