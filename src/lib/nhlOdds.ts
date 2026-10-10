import { supabaseAdmin } from "./supabase-admin";
import { normName } from "./nhlContext";
import { marketEdges } from "./nhlEdges";
import { simulateGame, type GoalieScenario } from "./nhlSim";
import { americanToProb } from "./nhlModel";
import type { NhlMarket, NhlModelDigest, NhlPrediction } from "./types";

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

type EspnPrice = { close?: { odds?: string; line?: string }; open?: { odds?: string; line?: string } };
type EspnOdds = {
  provider?: { name?: string };
  moneyline?: { home?: EspnPrice; away?: EspnPrice };
  pointSpread?: { home?: EspnPrice; away?: EspnPrice };
  total?: { over?: EspnPrice; under?: EspnPrice };
};
type EspnProbable = { name?: string; athlete?: { displayName?: string }; status?: { type?: string } };
type EspnCompetitor = { homeAway?: string; probables?: EspnProbable[] };
type EspnBoard = {
  events?: { id: string; status?: { type?: { state?: string } }; competitions?: { odds?: EspnOdds[]; competitors?: EspnCompetitor[] }[] }[];
};

/** ESPN's probable starting goalie for one side, with whether the team has confirmed him. */
export type GoalieCall = { name: string; status: "expected" | "confirmed" };

/** Same fields, same "close" side, as parse_market in python/nhl_model/publish.py. */
function parseEspnMarket(o: EspnOdds, fetchedAt: string): NhlMarket {
  const ml = o.moneyline ?? {};
  const ps = o.pointSpread ?? {};
  const tot = o.total ?? {};
  return {
    provider: bookName(o.provider?.name),
    ml_home: espnOdds(ml.home?.close?.odds),
    ml_away: espnOdds(ml.away?.close?.odds),
    spread_home_line: espnLine(ps.home?.close?.line),
    spread_home_odds: espnOdds(ps.home?.close?.odds),
    spread_away_odds: espnOdds(ps.away?.close?.odds),
    total_line: espnLine(tot.over?.close?.line),
    over_odds: espnOdds(tot.over?.close?.odds),
    under_odds: espnOdds(tot.under?.close?.odds),
    ml_home_open: espnOdds(ml.home?.open?.odds),
    ml_away_open: espnOdds(ml.away?.open?.odds),
    spread_home_line_open: espnLine(ps.home?.open?.line),
    spread_home_odds_open: espnOdds(ps.home?.open?.odds),
    spread_away_odds_open: espnOdds(ps.away?.open?.odds),
    total_line_open: espnLine(tot.over?.open?.line),
    over_odds_open: espnOdds(tot.over?.open?.odds),
    under_odds_open: espnOdds(tot.under?.open?.odds),
    fetched_at: fetchedAt,
  };
}

// ESPN's feed labels the same book "Draft Kings" on one response and "DraftKings" on the next, so the name is never part of
// "did a price move" - only the numbers are.
const PRICE_FIELDS = ["ml_home", "ml_away", "spread_home_line", "spread_home_odds", "spread_away_odds", "total_line", "over_odds", "under_odds"] as const;

const bookName = (name: string | undefined): string | null => (name ? (/draft\s*kings/i.test(name) ? "DraftKings" : name) : null);

const samePrices = (a: NhlMarket | null, b: NhlMarket): boolean => a !== null && PRICE_FIELDS.every((k) => a[k] === b[k]);

/** DraftKings lines AND ESPN's probable goalies for every upcoming (not started) NHL game ESPN lists, keyed by our game id.
 * Throws if ESPN is down. */
export async function fetchEspnMarkets(fetchedAt: string): Promise<{ markets: Map<number, NhlMarket>; goalies: Map<number, { home?: GoalieCall; away?: GoalieCall }> }> {
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
  const goalies = new Map<number, { home?: GoalieCall; away?: GoalieCall }>();
  for (const board of boards) {
    for (const ev of board?.events ?? []) {
      if (ev?.status?.type?.state !== "pre") continue;
      const gid = -(Number(ev.id) + NHL_GAME_ID_OFFSET);
      const o = ev?.competitions?.[0]?.odds?.[0];
      if (o) incoming.set(gid, parseEspnMarket(o, fetchedAt));
      const calls: { home?: GoalieCall; away?: GoalieCall } = {};
      for (const c of ev?.competitions?.[0]?.competitors ?? []) {
        const p = (c.probables ?? []).find((x) => x.name === "probableStartingGoalie" && x.athlete?.displayName);
        if (p && (c.homeAway === "home" || c.homeAway === "away")) {
          calls[c.homeAway] = { name: p.athlete!.displayName!, status: p.status?.type === "confirmed" ? "confirmed" : "expected" };
        }
      }
      if (calls.home || calls.away) goalies.set(gid, calls);
    }
  }
  return { markets: incoming, goalies };
}

// ---------------------------------------------------------------- goalie news between model refreshes

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch {
    /* an alert failing must never fail the update */
  }
}

type StoredGoalie = { id: number | null; name: string; weight: number; rating: number };
type Pool = { id: number | null; name: string; rating: number };

/** Applies ESPN's current probable goalies to the stored predictions: when a team confirms its starter (or ESPN switches
 * who it expects) the game is re-simulated on the spot with the same engine as a manual lock, the change is marked on
 * the price chart, and a Telegram message is sent if the bot is configured. Games with a manual lock are left alone.
 * The full model refresh (publish.py) still recomputes everything from scratch; this keeps the site current between runs. */
async function applyGoalieCalls(calls: Map<number, { home?: GoalieCall; away?: GoalieCall }>): Promise<number> {
  if (calls.size === 0) return 0;
  const { data: rows, error } = await supabaseAdmin.from("nhl_predictions").select("game_id, assumptions").in("game_id", [...calls.keys()]);
  if (error || !rows) return 0;

  let updated = 0;
  for (const row of rows) {
    const gameId = row.game_id as number;
    const a = row.assumptions as NhlPrediction["assumptions"];
    const c = calls.get(gameId);
    if (!a || !c) continue;
    const todo: Partial<Record<"home" | "away", GoalieCall>> = {};
    for (const side of ["home", "away"] as const) {
      const call = c[side];
      if (!call || a.sources?.[side] === "locked") continue;
      const list = a.goalies[side] ?? [];
      const top = [...list].sort((x, y) => y.weight - x.weight)[0];
      const same = top !== undefined && normName(top.name) === normName(call.name);
      if (call.status === "confirmed") {
        if (a.confirmed?.[side] && same && list.length === 1) continue;
        todo[side] = call;
      } else if (!same && a.sources?.[side] !== "espn_confirmed") {
        todo[side] = call;
      }
    }
    if (!todo.home && !todo.away) continue;

    // full row (the simulation inputs are big, so they are only read when something actually changed)
    const { data: full } = await supabaseAdmin.from("nhl_predictions").select("p_home, sim_params, assumptions").eq("game_id", gameId).maybeSingle();
    const sp = full?.sim_params as NhlPrediction["sim_params"];
    const cur = full?.assumptions as NonNullable<NhlPrediction["assumptions"]>;
    if (!sp || !cur) continue;

    const nextGoalies = { home: [...cur.goalies.home] as StoredGoalie[], away: [...cur.goalies.away] as StoredGoalie[] };
    const confirmed = { home: Boolean(cur.confirmed?.home), away: Boolean(cur.confirmed?.away) };
    const sources = { home: cur.sources?.home ?? "usage", away: cur.sources?.away ?? "usage" } as Record<"home" | "away", string>;
    const estimated = sp.estimated as unknown as Record<"home" | "away", { goalies: StoredGoalie[]; source: string; confirmed: boolean }>;
    const notes: string[] = [];

    for (const side of ["home", "away"] as const) {
      const call = todo[side];
      if (!call) continue;
      const pool = (sp.pool?.[side] ?? []) as Pool[];
      const hit = pool.find((p) => normName(p.name) === normName(call.name));
      const goalie: StoredGoalie = { id: hit?.id ?? null, name: hit?.name ?? call.name, weight: 1, rating: hit?.rating ?? 0 };
      const prevTop = [...cur.goalies[side]].sort((x, y) => y.weight - x.weight)[0];
      if (call.status === "confirmed") {
        nextGoalies[side] = [goalie];
        confirmed[side] = true;
        sources[side] = "espn_confirmed";
        notes.push(`${goalie.name} confirmed${prevTop && normName(prevTop.name) !== normName(goalie.name) ? ` (was expecting ${prevTop.name})` : ""}`);
      } else {
        // ESPN now expects a different goalie: lean on him, keep the previous expectation as the hedge
        const hedge = prevTop && normName(prevTop.name) !== normName(goalie.name) ? [{ ...prevTop, weight: 0.15 }] : [];
        goalie.weight = hedge.length ? 0.85 : 1;
        nextGoalies[side] = [goalie, ...hedge];
        confirmed[side] = false;
        sources[side] = "espn_expected";
        notes.push(`ESPN now expects ${goalie.name}`);
      }
      estimated[side] = { goalies: nextGoalies[side], source: sources[side], confirmed: confirmed[side] };
    }

    const toScenario = (g: StoredGoalie): GoalieScenario => ({ rating: g.rating, weight: g.weight });
    const sim = simulateGame(sp.rates, sp.tables, nextGoalies.home.map(toScenario), nextGoalies.away.map(toScenario), 40000, Math.abs(gameId) % 1000003);
    const assumptions = {
      ...cur,
      goalies: nextGoalies,
      goalie_confirmed: confirmed.home && confirmed.away,
      sources,
      confirmed,
    };
    const { error: upErr } = await supabaseAdmin.from("nhl_predictions").update({ ...sim, assumptions, sim_params: { ...sp, estimated } }).eq("game_id", gameId);
    if (upErr) continue;
    updated++;
    await recordModelSnapshot(gameId).catch(() => undefined);

    // keep the goalie-accuracy log's "last look" current too (best effort)
    for (const side of ["home", "away"] as const) {
      if (!todo[side]) continue;
      await supabaseAdmin
        .from("nhl_goalie_log")
        .update({
          espn_name: todo[side]!.name,
          espn_status: todo[side]!.status,
          source: sources[side],
          model: nextGoalies[side].map((g) => ({ id: g.id, name: g.name, p: g.weight })),
          top_id: nextGoalies[side][0]?.id ?? null,
          top_name: nextGoalies[side][0]?.name ?? null,
          top_p: nextGoalies[side][0]?.weight ?? null,
          logged_at: new Date().toISOString(),
        })
        .eq("game_id", gameId)
        .eq("side", side)
        .eq("kind", "last");
    }

    const { data: g } = await supabaseAdmin.from("games").select("home_team, away_team").eq("id", gameId).maybeSingle();
    const before = Number((full as { p_home?: number }).p_home ?? sim.p_home);
    await sendTelegram(
      `🥅 ${g?.away_team ?? "Away"} @ ${g?.home_team ?? "Home"}\n${notes.join("\n")}\nModel: ${g?.home_team ?? "Home"} win ${(before * 100).toFixed(1)}% → ${(sim.p_home * 100).toFixed(1)}%`,
    );
  }
  return updated;
}

// ---------------------------------------------------------------- model state saved with snapshots

type PredForDigest = { generated_at?: unknown; p_home?: unknown; margin_dist?: unknown; total_dist?: unknown; assumptions?: unknown };

function digestOf(pred: PredForDigest): NhlModelDigest {
  const a = (pred.assumptions ?? {}) as {
    goalies?: { home?: { id: number | null; name: string; weight: number }[]; away?: { id: number | null; name: string; weight: number }[] };
    confirmed?: { home?: boolean; away?: boolean };
    sources?: { home?: string; away?: string };
  };
  return {
    generated_at: String(pred.generated_at ?? ""),
    p_home: Number(pred.p_home),
    margin_dist: (pred.margin_dist ?? {}) as Record<string, number>,
    total_dist: (pred.total_dist ?? {}) as Record<string, number>,
    goalies: {
      home: (a.goalies?.home ?? []).map((g) => ({ id: g.id, name: g.name, weight: Math.round(g.weight * 100) / 100 })),
      away: (a.goalies?.away ?? []).map((g) => ({ id: g.id, name: g.name, weight: Math.round(g.weight * 100) / 100 })),
    },
    confirmed: { home: Boolean(a.confirmed?.home), away: Boolean(a.confirmed?.away) },
    sources: { home: a.sources?.home ?? "", away: a.sources?.away ?? "" },
  };
}

/** What identifies a model state for change detection: who is in goal (and how sure), plus the win probability to a point. */
function modelKey(d: NhlModelDigest): string {
  const g = (side: "home" | "away") => d.goalies[side].map((x) => `${x.id ?? x.name}:${x.weight}`).join(",");
  return `${g("home")}|${g("away")}|${d.confirmed.home ? 1 : 0}${d.confirmed.away ? 1 : 0}|${d.sources.home}/${d.sources.away}|${d.p_home.toFixed(2)}`;
}

const nick = (team: string) => team.split(" ").slice(-1)[0];
const topGoalie = (g: { id: number | null; name: string; weight: number }[]) => [...g].sort((a, b) => b.weight - a.weight)[0];

/** A short description of what changed in the model between two states - shown on the chart's top label. */
function modelNote(prev: NhlModelDigest, cur: NhlModelDigest, home: string, away: string): string {
  const notes: string[] = [];
  for (const side of ["away", "home"] as const) {
    const team = nick(side === "home" ? home : away);
    const p = topGoalie(prev.goalies[side]);
    const c = topGoalie(cur.goalies[side]);
    if (!c) continue;
    if (cur.sources[side] === "locked" && prev.sources[side] !== "locked") notes.push(`${team} goalie locked: ${c.name}`);
    else if (p && (p.id !== c.id || p.name !== c.name)) notes.push(`${team} starter: ${p.name} → ${c.name}`);
    else if (!prev.confirmed[side] && cur.confirmed[side]) notes.push(`${team} goalie confirmed: ${c.name}`);
    else if (cur.sources[side] !== prev.sources[side] && cur.sources[side] === "espn_expected") notes.push(`${team} goalie expected: ${c.name}`);
  }
  if (notes.length === 0) notes.push(`Model re-run: ${nick(home)} win ${(prev.p_home * 100).toFixed(1)}% → ${(cur.p_home * 100).toFixed(1)}%`);
  return notes.join(" · ");
}

/** Inserts snapshot rows; if the model columns haven't been added yet, saves the prices without them. */
async function insertSnapshots(rows: Record<string, unknown>[]): Promise<{ message: string; missing: boolean } | null> {
  let { error } = await supabaseAdmin.from("nhl_odds_snapshots").insert(rows);
  if (error && /column/i.test(error.message) && /model/i.test(error.message)) {
    const slim = rows.map((r) => {
      const copy = { ...r };
      delete copy.model;
      delete copy.model_note;
      return copy;
    });
    ({ error } = await supabaseAdmin.from("nhl_odds_snapshots").insert(slim));
  }
  return error ? { message: error.message, missing: isMissingTable(error) } : null;
}

/** The most recently SAVED model state for a game (null if none, or the model columns don't exist yet). */
async function lastSavedModel(gameId: number): Promise<NhlModelDigest | null> {
  const { data, error } = await supabaseAdmin.from("nhl_odds_snapshots").select("model").eq("game_id", gameId).not("model", "is", null).order("captured_at", { ascending: false }).limit(1);
  if (error || !data?.[0]) return null;
  return data[0].model as NhlModelDigest;
}

/** Called right after the model for one game changes outside a full refresh (a goalie lock): saves a snapshot on the spot
 * so the chart marks it at the right time. A no-op when nothing about the model actually changed. */
export async function recordModelSnapshot(gameId: number): Promise<void> {
  if ((await supabaseAdmin.from("nhl_odds_snapshots").select("model").limit(1)).error) return; // model columns not migrated yet
  const { data: p } = await supabaseAdmin.from("nhl_predictions").select("game_id, generated_at, p_home, margin_dist, total_dist, assumptions, market").eq("game_id", gameId).maybeSingle();
  const market = (p?.market ?? null) as NhlMarket | null;
  if (!p || !market) return;
  const { data: g } = await supabaseAdmin.from("games").select("home_team, away_team").eq("id", gameId).maybeSingle();
  const cur = digestOf(p);
  const key = modelKey(cur);
  if (market.model_key === key) return;
  const last = await lastSavedModel(gameId);
  if (last && modelKey(last) === key) return;
  const capturedAt = new Date().toISOString();
  const row = {
    game_id: gameId,
    captured_at: capturedAt,
    provider: market.provider ?? null,
    ml_home: market.ml_home ?? null,
    ml_away: market.ml_away ?? null,
    spread_home_line: market.spread_home_line ?? null,
    spread_home_odds: market.spread_home_odds ?? null,
    spread_away_odds: market.spread_away_odds ?? null,
    total_line: market.total_line ?? null,
    over_odds: market.over_odds ?? null,
    under_odds: market.under_odds ?? null,
    model: cur,
    model_note: last ? modelNote(last, cur, g?.home_team ?? "Home", g?.away_team ?? "Away") : null,
  };
  const err = await insertSnapshots([row]);
  if (!err) await supabaseAdmin.from("nhl_predictions").update({ market: { ...market, model_key: key, snap_at: capturedAt } }).eq("game_id", gameId);
}

export type OddsUpdateResult = { ok: boolean; message: string; games: number; moved: number; snapshots: number; logged: number; graded: number; goalies?: number };

const fail = (message: string): OddsUpdateResult => ({ ok: false, message, games: 0, moved: 0, snapshots: 0, logged: 0, graded: 0 });

/** The whole update. Safe to call as often as you like: it only writes what changed. */
export async function updateNhlOdds(): Promise<OddsUpdateResult> {
  const fetchedAt = new Date().toISOString();
  let incoming: Map<number, NhlMarket>;
  let goalieCalls: Map<number, { home?: GoalieCall; away?: GoalieCall }>;
  try {
    const fetched = await fetchEspnMarkets(fetchedAt);
    incoming = fetched.markets;
    goalieCalls = fetched.goalies;
  } catch (e) {
    return fail(`Couldn't reach ESPN: ${e instanceof Error ? e.message : "unknown error"}.`);
  }

  // goalie news first, so the prices below are compared against the freshest model
  let goalieUpdates = 0;
  try {
    goalieUpdates = await applyGoalieCalls(goalieCalls);
  } catch {
    /* never let goalie handling stop the odds update */
  }

  // 1. new prices -> the stored market of each published prediction, plus a snapshot when a price moved
  let moved = 0;
  let snapshots = 0;
  let logged = 0;
  let games = 0;
  if (incoming.size > 0) {
    const { data: preds, error } = await supabaseAdmin
      .from("nhl_predictions")
      .select("game_id, generated_at, p_home, margin_dist, total_dist, assumptions, market")
      .in("game_id", [...incoming.keys()]);
    if (error) return fail(error.message);
    games = preds?.length ?? 0;

    // A full model refresh rewrites a prediction's market without our snap_at marker. For those games, compare against the
    // latest SAVED snapshot instead, so prices that didn't move never produce a duplicate snapshot.
    const lastSnap = new Map<number, NhlMarket>();
    await Promise.all(
      (preds ?? [])
        .filter((p) => !(p.market as NhlMarket | null)?.snap_at)
        .map(async (p) => {
          const { data: latest, error: snapErr } = await supabaseAdmin
            .from("nhl_odds_snapshots")
            .select("captured_at, ml_home, ml_away, spread_home_line, spread_home_odds, spread_away_odds, total_line, over_odds, under_odds")
            .eq("game_id", p.game_id)
            .order("captured_at", { ascending: false })
            .limit(1);
          if (!snapErr && latest?.[0]) lastSnap.set(p.game_id as number, { ...(latest[0] as unknown as NhlMarket), snap_at: latest[0].captured_at as string });
        }),
    );

    // The model columns come from a separate migration. Until they exist the model isn't tracked at all (and no snapshot is
    // saved just for a model change), so nothing is written that couldn't be read back.
    const hasModelCols = !(await supabaseAdmin.from("nhl_odds_snapshots").select("model").limit(1)).error;

    // model state: only look the last saved one up when the stored fingerprint doesn't already match
    const { data: gameNames } = await supabaseAdmin.from("games").select("id, home_team, away_team").in("id", (preds ?? []).map((p) => p.game_id as number));
    const nameById = new Map((gameNames ?? []).map((g) => [g.id as number, g]));
    const lastModel = new Map<number, NhlModelDigest | null>();
    await Promise.all(
      (preds ?? [])
        .filter((p) => hasModelCols && (p.market as NhlMarket | null)?.model_key !== modelKey(digestOf(p)))
        .map(async (p) => {
          lastModel.set(p.game_id as number, await lastSavedModel(p.game_id as number));
        }),
    );

    const snapRows: Record<string, unknown>[] = [];
    const updates = (preds ?? []).map((p) => {
      const next = incoming.get(p.game_id as number)!;
      const prev = (p.market ?? null) as NhlMarket | null;
      const changed = !samePrices(prev, next);
      if (changed) moved++;
      // what was last saved: the stored market if it carries our marker, else the newest snapshot row (if any)
      const saved = prev?.snap_at ? prev : (lastSnap.get(p.game_id as number) ?? null);
      const priceSnap = !samePrices(saved, next);

      const cur = digestOf(p);
      const key = modelKey(cur);
      let modelChanged = false;
      let note: string | null = null;
      if (hasModelCols && prev?.model_key !== key) {
        const last = lastModel.get(p.game_id as number) ?? null;
        if (!last || modelKey(last) !== key) {
          modelChanged = true;
          const t = nameById.get(p.game_id as number);
          note = last ? modelNote(last, cur, t?.home_team ?? "Home", t?.away_team ?? "Away") : null;
        }
      }
      const needSnap = priceSnap || modelChanged;
      const market: NhlMarket = { ...(prev ?? {}), ...next, model_key: hasModelCols ? key : (prev?.model_key ?? null), snap_at: needSnap ? fetchedAt : (saved?.snap_at ?? fetchedAt) };
      if (needSnap) {
        snapRows.push({
          game_id: p.game_id,
          captured_at: fetchedAt,
          provider: next.provider,
          ml_home: next.ml_home,
          ml_away: next.ml_away,
          spread_home_line: next.spread_home_line,
          spread_home_odds: next.spread_home_odds,
          spread_away_odds: next.spread_away_odds,
          total_line: next.total_line,
          over_odds: next.over_odds,
          under_odds: next.under_odds,
          model: modelChanged ? cur : null,
          model_note: modelChanged ? note : null,
        });
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
      const snapErr = await insertSnapshots(snapRows);
      // the tables are optional until the migration has been run - never block the odds update on them
      if (snapErr && !snapErr.missing) return fail(snapErr.message);
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

  const base = games === 0 ? "No upcoming published games have DraftKings lines on ESPN yet." : `DraftKings odds updated for ${games} games (${moved} had moved).`;
  const message = goalieUpdates > 0 ? `${base} ${goalieUpdates} game${goalieUpdates === 1 ? "" : "s"} re-simulated for goalie news.` : base;
  return { ok: true, message, games, moved, snapshots, logged, graded, goalies: goalieUpdates };
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
