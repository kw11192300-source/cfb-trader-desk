import { supabaseAdmin } from "./supabase-admin";
import { marketEdges } from "./nhlEdges";
import { americanToProb } from "./nhlModel";
import type { NhlMarket, NhlPrediction } from "./types";

// Server-only. The DraftKings odds update behind the "Update DK odds" button and the ~10-minute timer
// (src/app/api/cron/nhl-odds/route.ts): re-read ESPN's lines for upcoming games, save a snapshot whenever a price moved,
// log every side the model priced (first sighting + last look before the game), and grade logged sides once games end.

const ESPN_NHL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard";
const NHL_GAME_ID_OFFSET = 5_000_000_000; // games.id = -(ESPN event id + this) - see sync_nhl_espn.py

const espnLine = (s: unknown): number | null => {
  if (s == null) return null;
  const n = Number(String(s).replace(/^[ou]/, ""));
  return Number.isFinite(n) ? n : null;
};
const espnOdds = (s: unknown): number | null => {
  if (s == null) return null;
  const n = Number(String(s).replace("+", ""));
  return Number.isFinite(n) ? Math.round(n) : null;
};

type EspnPrice = { close?: { odds?: string; line?: string } };
type EspnOdds = {
  provider?: { name?: string };
  moneyline?: { home?: EspnPrice; away?: EspnPrice };
  pointSpread?: { home?: EspnPrice; away?: EspnPrice };
  total?: { over?: EspnPrice; under?: EspnPrice };
};
type EspnBoard = { events?: { id: string; status?: { type?: { state?: string } }; competitions?: { odds?: EspnOdds[] }[] }[] };

/** Same fields, same "close" side, as parse_market in python/nhl_model/publish.py. */
function parseEspnMarket(o: EspnOdds, fetchedAt: string): NhlMarket {
  const ml = o.moneyline ?? {};
  const ps = o.pointSpread ?? {};
  const tot = o.total ?? {};
  return {
    provider: o.provider?.name ?? null,
    ml_home: espnOdds(ml.home?.close?.odds),
    ml_away: espnOdds(ml.away?.close?.odds),
    spread_home_line: espnLine(ps.home?.close?.line),
    spread_home_odds: espnOdds(ps.home?.close?.odds),
    spread_away_odds: espnOdds(ps.away?.close?.odds),
    total_line: espnLine(tot.over?.close?.line),
    over_odds: espnOdds(tot.over?.close?.odds),
    under_odds: espnOdds(tot.under?.close?.odds),
    fetched_at: fetchedAt,
  };
}

const PRICE_FIELDS = ["provider", "ml_home", "ml_away", "spread_home_line", "spread_home_odds", "spread_away_odds", "total_line", "over_odds", "under_odds"] as const;

const samePrices = (a: NhlMarket | null, b: NhlMarket): boolean => a !== null && PRICE_FIELDS.every((k) => a[k] === b[k]);

/** DraftKings lines for every upcoming (not started) NHL game ESPN lists, keyed by our game id. Throws if ESPN is down. */
export async function fetchEspnMarkets(fetchedAt: string): Promise<Map<number, NhlMarket>> {
  const now = Date.now();
  // ESPN's date parameter is a US calendar day, so cover a day either side of UTC today.
  const days = [-1, 0, 1, 2, 3].map((d) => new Date(now + d * 86400000).toISOString().slice(0, 10).replaceAll("-", ""));
  const boards: EspnBoard[] = await Promise.all(
    days.map(async (d) => {
      const res = await fetch(`${ESPN_NHL_SCOREBOARD}?dates=${d}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
      return res.json();
    }),
  );
  const incoming = new Map<number, NhlMarket>();
  for (const board of boards) {
    for (const ev of board?.events ?? []) {
      if (ev?.status?.type?.state !== "pre") continue;
      const o = ev?.competitions?.[0]?.odds?.[0];
      if (!o) continue;
      incoming.set(-(Number(ev.id) + NHL_GAME_ID_OFFSET), parseEspnMarket(o, fetchedAt));
    }
  }
  return incoming;
}

export type OddsUpdateResult = { ok: boolean; message: string; games: number; moved: number; snapshots: number; logged: number; graded: number };

const fail = (message: string): OddsUpdateResult => ({ ok: false, message, games: 0, moved: 0, snapshots: 0, logged: 0, graded: 0 });

/** The whole update. Safe to call as often as you like: it only writes what changed. */
export async function updateNhlOdds(): Promise<OddsUpdateResult> {
  const fetchedAt = new Date().toISOString();
  let incoming: Map<number, NhlMarket>;
  try {
    incoming = await fetchEspnMarkets(fetchedAt);
  } catch (e) {
    return fail(`Couldn't reach ESPN: ${e instanceof Error ? e.message : "unknown error"}.`);
  }

  // 1. new prices -> the stored market of each published prediction, plus a snapshot when a price moved
  let moved = 0;
  let snapshots = 0;
  let logged = 0;
  let games = 0;
  if (incoming.size > 0) {
    const { data: preds, error } = await supabaseAdmin
      .from("nhl_predictions")
      .select("game_id, p_home, margin_dist, total_dist, market")
      .in("game_id", [...incoming.keys()]);
    if (error) return fail(error.message);
    games = preds?.length ?? 0;

    const snapRows: Record<string, unknown>[] = [];
    const updates = (preds ?? []).map((p) => {
      const next = incoming.get(p.game_id as number)!;
      const prev = (p.market ?? null) as NhlMarket | null;
      const changed = !samePrices(prev, next);
      if (changed) moved++;
      const needSnap = changed || !prev?.snap_at;
      const market: NhlMarket = { ...(prev ?? {}), ...next, snap_at: needSnap ? fetchedAt : prev?.snap_at };
      if (needSnap) {
        snapRows.push({ game_id: p.game_id, captured_at: fetchedAt, provider: next.provider, ml_home: next.ml_home, ml_away: next.ml_away, spread_home_line: next.spread_home_line, spread_home_odds: next.spread_home_odds, spread_away_odds: next.spread_away_odds, total_line: next.total_line, over_odds: next.over_odds, under_odds: next.under_odds });
      }
      return { pred: p, market };
    });

    const failures: string[] = [];
    await Promise.all(
      updates.map(async ({ pred, market }) => {
        const { error: upErr } = await supabaseAdmin.from("nhl_predictions").update({ market }).eq("game_id", pred.game_id);
        if (upErr) failures.push(upErr.message);
      }),
    );
    if (failures.length > 0) return fail(`Some updates failed: ${failures[0]}`);

    if (snapRows.length > 0) {
      const { error: snapErr } = await supabaseAdmin.from("nhl_odds_snapshots").insert(snapRows);
      // the tables are optional until the migration has been run - never block the odds update on them
      if (snapErr && !isMissingTable(snapErr)) return fail(snapErr.message);
      if (!snapErr) snapshots = snapRows.length;
    }

    // 2. the edge log: 'first' once per game, 'close' rewritten every update until the game starts
    const { data: names } = await supabaseAdmin.from("games").select("id, home_team, away_team").in("id", updates.map((u) => u.pred.game_id as number));
    const teamsById = new Map((names ?? []).map((g) => [g.id as number, g]));
    const edgeRows = updates.flatMap(({ pred, market }) =>
      marketEdges(
        { p_home: pred.p_home as number, margin_dist: pred.margin_dist as NhlPrediction["margin_dist"], total_dist: pred.total_dist as NhlPrediction["total_dist"], market },
        teamsById.get(pred.game_id as number)?.home_team ?? "Home",
        teamsById.get(pred.game_id as number)?.away_team ?? "Away",
      ).map((e) => ({
        game_id: pred.game_id as number,
        market: e.market,
        side_key: e.sideKey,
        side: e.side,
        line: e.line,
        book_odds: e.bookOdds,
        book_implied: e.bookImplied,
        model_prob: e.model,
        ev: e.ev,
      })),
    );
    if (edgeRows.length > 0) {
      const ids = [...new Set(edgeRows.map((r) => r.game_id))];
      const { data: haveFirst, error: firstErr } = await supabaseAdmin.from("nhl_edge_log").select("game_id").eq("kind", "first").in("game_id", ids);
      if (firstErr && !isMissingTable(firstErr)) return fail(firstErr.message);
      if (!firstErr) {
        const has = new Set((haveFirst ?? []).map((r) => r.game_id as number));
        const firsts = edgeRows.filter((r) => !has.has(r.game_id)).map((r) => ({ ...r, kind: "first", logged_at: fetchedAt }));
        const closes = edgeRows.map((r) => ({ ...r, kind: "close", logged_at: fetchedAt }));
        const a = await supabaseAdmin.from("nhl_edge_log").upsert([...firsts, ...closes], { onConflict: "game_id,kind,market,side_key", ignoreDuplicates: false });
        if (a.error) return fail(a.error.message);
        logged = firsts.length;
      }
    }
  }

  // 3. grade anything that finished
  let graded = 0;
  try {
    graded = await gradeNhlEdgeLog(7);
  } catch (e) {
    return { ok: false, message: `Odds updated, but grading failed: ${e instanceof Error ? e.message : "unknown error"}.`, games, moved, snapshots, logged, graded: 0 };
  }

  const message = games === 0 ? "No upcoming published games have DraftKings lines on ESPN yet." : `DraftKings odds updated for ${games} games (${moved} had moved).`;
  return { ok: true, message, games, moved, snapshots, logged, graded };
}

type EspnScoreboard = {
  events?: {
    id: string;
    season?: { type?: number };
    status?: { period?: number; displayClock?: string; type?: { state?: string; completed?: boolean; shortDetail?: string } };
    competitions?: { competitors?: { homeAway: string; score?: string }[] }[];
  }[];
};

export type ScoreUpdateResult = { ok: boolean; message: string; games: number; updated: number; live: number; final: number; graded: number };

const noScores = (ok: boolean, message: string): ScoreUpdateResult => ({ ok, message, games: 0, updated: 0, live: 0, final: 0, graded: 0 });

/** Re-reads ESPN's scoreboard for the last two days plus today and tomorrow, and brings the scores, final status and live
 * status of games we already have in line with it - the same fields the scheduled sync_nhl_espn job writes, but on demand
 * (and on the odds timer). Only existing rows are touched; the schedule itself still comes from that job. Optionally grades
 * the edge log for anything that just went final. */
export async function updateNhlScores(opts: { grade?: boolean } = {}): Promise<ScoreUpdateResult> {
  const nowIso = new Date().toISOString();
  const now = Date.now();
  const days = [-2, -1, 0, 1].map((d) => new Date(now + d * 86400000).toISOString().slice(0, 10).replaceAll("-", ""));
  let boards: EspnScoreboard[];
  try {
    boards = await Promise.all(
      days.map(async (d) => {
        const res = await fetch(`${ESPN_NHL_SCOREBOARD}?dates=${d}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
        return res.json();
      }),
    );
  } catch (e) {
    return noScores(false, `Couldn't reach ESPN: ${e instanceof Error ? e.message : "unknown error"}.`);
  }

  type Live = { home_points: number; away_points: number; period: number | null; clock: string | null; detail: string | null; updated_at: string };
  type Next = { completed: boolean; home_points: number | null; away_points: number | null; live_status: Live | null };
  const next = new Map<number, Next>();
  for (const board of boards) {
    for (const e of board.events ?? []) {
      if (e.season?.type !== 2) continue; // regular season only, like the scheduled sync
      const comps = e.competitions?.[0]?.competitors ?? [];
      const home = comps.find((c) => c.homeAway === "home");
      const away = comps.find((c) => c.homeAway === "away");
      if (!home || !away) continue;
      const hp = home.score !== undefined && home.score !== "" ? Number(home.score) : null;
      const ap = away.score !== undefined && away.score !== "" ? Number(away.score) : null;
      next.set(-(Number(e.id) + NHL_GAME_ID_OFFSET), {
        completed: Boolean(e.status?.type?.completed),
        home_points: hp,
        away_points: ap,
        live_status:
          e.status?.type?.state === "in" && hp !== null && ap !== null
            ? { home_points: hp, away_points: ap, period: e.status?.period ?? null, clock: e.status?.displayClock ?? null, detail: e.status?.type?.shortDetail ?? null, updated_at: nowIso }
            : null,
      });
    }
  }
  if (next.size === 0) return noScores(true, "No NHL games in ESPN's scoreboard for the last two days.");

  const { data: rows, error } = await supabaseAdmin.from("games").select("id, completed, home_points, away_points, live_status").in("id", [...next.keys()]);
  if (error) return noScores(false, error.message);

  let updated = 0;
  const failures: string[] = [];
  await Promise.all(
    (rows ?? []).map(async (r) => {
      const n = next.get(r.id as number)!;
      // a ticking clock alone is worth a write (it is what the live board shows); anything identical is skipped
      const old = r.live_status as Live | null;
      const liveSame = (old === null && n.live_status === null) || (old !== null && n.live_status !== null && old.home_points === n.live_status.home_points && old.away_points === n.live_status.away_points && old.period === n.live_status.period && old.clock === n.live_status.clock);
      if (r.completed === n.completed && r.home_points === n.home_points && r.away_points === n.away_points && liveSame) return;
      const { error: upErr } = await supabaseAdmin.from("games").update(n).eq("id", r.id);
      if (upErr) failures.push(upErr.message);
      else updated++;
    }),
  );
  if (failures.length > 0) return { ...noScores(false, `Some score updates failed: ${failures[0]}`), games: rows?.length ?? 0, updated };

  let graded = 0;
  if (opts.grade) {
    try {
      graded = await gradeNhlEdgeLog(7);
    } catch {
      /* best effort here - the odds update retries grading */
    }
  }
  const all = [...next.values()];
  const live = all.filter((n) => n.live_status !== null).length;
  const final = all.filter((n) => n.completed).length;
  return {
    ok: true,
    message: `Scores checked for ${rows?.length ?? 0} games - ${updated} changed (${live} live, ${final} final)${graded > 0 ? `, ${graded} logged edges graded` : ""}.`,
    games: rows?.length ?? 0,
    updated,
    live,
    final,
    graded,
  };
}

function isMissingTable(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST205" || error.code === "42P01" || /schema cache|does not exist/i.test(error.message);
}

const decimal = (american: number): number => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);

type LogRow = {
  id: number;
  game_id: number;
  kind: string;
  market: "Moneyline" | "Puck line" | "Total";
  side_key: "home" | "away" | "over" | "under";
  line: number | null;
  book_odds: number;
  result: string | null;
};

function settle(r: LogRow, home: number, away: number): "win" | "loss" | "push" {
  if (r.market === "Moneyline") return (r.side_key === "home" ? home > away : away > home) ? "win" : "loss";
  if (r.market === "Puck line") {
    const m = (r.side_key === "home" ? home - away : away - home) + (r.line ?? 0);
    return m > 0 ? "win" : m === 0 ? "push" : "loss";
  }
  const total = home + away;
  const line = r.line ?? 0;
  if (total === line) return "push";
  return (r.side_key === "over" ? total > line : total < line) ? "win" : "loss";
}

/** Settles logged sides for games that finished in the last `days` days, and fills in closing-line value for the 'first'
 * rows. Returns how many rows were graded. A no-op until the edge log table exists. */
export async function gradeNhlEdgeLog(days: number): Promise<number> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: games, error } = await supabaseAdmin.from("games").select("id, home_points, away_points").eq("sport", "nhl").eq("completed", true).gt("start_date", since);
  if (error) throw new Error(error.message);
  const done = (games ?? []).filter((g) => g.home_points !== null && g.away_points !== null);
  if (done.length === 0) return 0;
  const { data: rows, error: rowErr } = await supabaseAdmin.from("nhl_edge_log").select("id, game_id, kind, market, side_key, line, book_odds, result").in("game_id", done.map((g) => g.id));
  if (rowErr) {
    if (isMissingTable(rowErr)) return 0;
    throw new Error(rowErr.message);
  }
  const score = new Map(done.map((g) => [g.id as number, [g.home_points as number, g.away_points as number] as const]));
  const all = (rows ?? []) as LogRow[];
  const closeBy = new Map(all.filter((r) => r.kind === "close").map((r) => [`${r.game_id}|${r.market}|${r.side_key}`, r]));

  let n = 0;
  await Promise.all(
    all
      .filter((r) => r.result === null)
      .map(async (r) => {
        const [h, a] = score.get(r.game_id)!;
        const result = settle(r, h, a);
        const profit = result === "win" ? decimal(r.book_odds) - 1 : result === "loss" ? -1 : 0;
        const patch: Record<string, unknown> = { result, profit, graded_at: new Date().toISOString() };
        if (r.kind === "first") {
          const close = closeBy.get(`${r.game_id}|${r.market}|${r.side_key}`);
          if (close && (close.line ?? null) === (r.line ?? null)) {
            patch.close_odds = close.book_odds;
            patch.clv_pts = (americanToProb(close.book_odds) - americanToProb(r.book_odds)) * 100;
          }
        }
        const { error: upErr } = await supabaseAdmin.from("nhl_edge_log").update(patch).eq("id", r.id);
        if (!upErr) n++;
      }),
  );
  return n;
}
