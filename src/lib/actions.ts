"use server";

import { revalidatePath } from "next/cache";
import { simulateGame, type GoalieScenario } from "@/lib/nhlSim";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { GoalieSource, NhlGoalie, NhlMarket, NhlPrediction } from "@/lib/types";

/** Logs a real bet. Called from a <form action={logBet}> in a Client
 * Component - the action itself runs server-side only (that's what "use
 * server" means), so supabaseAdmin's secret key never reaches the browser
 * even though the form triggering it (on /edges) is client-rendered. Lives
 * here rather than under app/edges since deleteBet is also used from /bets. */
export async function logBet(formData: FormData): Promise<void> {
  const sport = (formData.get("sport") as string) || "cfb";
  const market = (formData.get("market") as string) || "spread";
  const model_version = (formData.get("model_version") as string) || null;
  const player = (formData.get("player") as string) || null;
  const prop_type = (formData.get("prop_type") as string) || null;
  const oddsRaw = formData.get("odds");
  const odds = oddsRaw && String(oddsRaw).trim() !== "" ? Number(oddsRaw) : -110;
  const stake = Number(formData.get("stake"));
  const sportsbook = (formData.get("sportsbook") as string) || null;
  const edgeSourceRaw = formData.get("edge_source") as string;
  const edge_source = ["model", "market", "both"].includes(edgeSourceRaw) ? edgeSourceRaw : "model";
  const notes = (formData.get("notes") as string) || null;

  if (!stake || stake <= 0 || Number.isNaN(odds)) {
    throw new Error("Missing or invalid bet fields.");
  }

  let game_id: number | null;
  let side: string;
  let line: number;
  let legs: string[] | null = null;

  if (market === "parlay") {
    // One leg per non-empty line of the textarea - free text, not tied to
    // a specific game/market, since a parlay is always settled manually
    // anyway (see manual_result) - see schema.sql's legs docstring.
    legs = ((formData.get("legs") as string) || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (legs.length < 2) {
      throw new Error("A parlay needs at least 2 legs.");
    }
    game_id = null;
    side = `${legs.length}-Leg Parlay`;
    line = 0;
  } else {
    const gameIdRaw = Number(formData.get("game_id"));
    const sideRaw = formData.get("side") as string;
    const lineRaw = Number(formData.get("line"));
    if (!gameIdRaw || !sideRaw || Number.isNaN(lineRaw)) {
      throw new Error("Missing or invalid bet fields.");
    }
    if (market === "prop" && !player) {
      throw new Error("A prop bet needs a player name.");
    }
    game_id = gameIdRaw;
    side = sideRaw;
    line = lineRaw;
  }

  const { error } = await supabaseAdmin
    .from("bets")
    .insert({ sport, game_id, model_version, market, side, player, prop_type, legs, line, odds, stake, sportsbook, edge_source, notes });
  if (error) throw new Error(error.message);

  revalidatePath("/bets");
  revalidatePath("/nfl/bets");
}

/** Manually settles a bet - the ONLY way a prop ever gets graded (no
 * player-stats feed exists to check it automatically), and a general
 * override for any bet whose real result needs a human call. Setting it
 * back to null un-does the override and returns the bet to live grading. */
export async function setManualResult(id: number, result: "win" | "loss" | "push" | null): Promise<void> {
  const { error } = await supabaseAdmin.from("bets").update({ manual_result: result }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/bets");
  revalidatePath("/nfl/bets");
}

/** Removes a logged bet (e.g. a typo, or a bet that never actually got
 * placed) - takes the id directly since this is called via a bound form
 * action (see BetsLedger.tsx), not a raw <form>. */
export async function deleteBet(id: number): Promise<void> {
  const { error } = await supabaseAdmin.from("bets").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/bets");
  revalidatePath("/nfl/bets");
}

// --- NHL model refresh -------------------------------------------------------
// The refresh itself (nhl_model.daily) can't run on Vercel - it needs ~13.5k games
// of play-by-play history, Python, and minutes of compute - so the button asks
// GitHub Actions to run it (.github/workflows/nhl-refresh.yml). The token only
// needs "Actions: read & write" on this one repo; it's a server-only env var, so
// it never reaches the browser, and these actions sit behind the site password.
const GITHUB_REPO = "kw11192300-source/cfb-trader-desk";
const NHL_WORKFLOW = "nhl-refresh.yml";

export type NhlRefreshStatus = {
  state: "none" | "queued" | "running" | "success" | "failed";
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
};

async function github(path: string, init?: RequestInit): Promise<Response> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

/** State of the most recent refresh run. Never throws - the board shouldn't break because GitHub's API did. */
export async function getNhlRefreshStatus(): Promise<NhlRefreshStatus> {
  const none: NhlRefreshStatus = { state: "none", createdAt: null, updatedAt: null, url: null };
  try {
    const res = await github(`/actions/workflows/${NHL_WORKFLOW}/runs?per_page=1`);
    if (!res.ok) return none;
    const run = (await res.json()).workflow_runs?.[0];
    if (!run) return none;
    const state: NhlRefreshStatus["state"] =
      run.status === "completed" ? (run.conclusion === "success" ? "success" : "failed") : run.status === "in_progress" ? "running" : "queued";
    return { state, createdAt: run.created_at, updatedAt: run.updated_at, url: run.html_url };
  } catch {
    return none;
  }
}

/** Starts a refresh run. Refuses if one is already queued or running. */
export async function triggerNhlRefresh(): Promise<{ ok: boolean; message: string }> {
  if (!process.env.GITHUB_DISPATCH_TOKEN) {
    return { ok: false, message: "Refresh isn't set up yet: GITHUB_DISPATCH_TOKEN is missing (see .env.local.example)." };
  }
  const current = await getNhlRefreshStatus();
  if (current.state === "queued" || current.state === "running") {
    return { ok: false, message: "A refresh is already running." };
  }
  const res = await github(`/actions/workflows/${NHL_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status === 204) return { ok: true, message: "Refresh started - about 8 minutes (the very first run takes ~30 while it downloads history)." };
  if (res.status === 404 || res.status === 403 || res.status === 401) {
    return { ok: false, message: "GitHub refused the request - check the token has Actions read & write on the repo." };
  }
  return { ok: false, message: `GitHub returned ${res.status}.` };
}

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

/** Odds-only refresh: re-reads ESPN's DraftKings lines for upcoming games and overwrites just the `market` of each
 * published prediction - takes a few seconds, no model refit (the model's own numbers are untouched, so compare
 * against it only until the next full refresh changes lineups or ratings). Games that already started are skipped. */
export async function refreshNhlOdds(): Promise<{ ok: boolean; message: string }> {
  const fetchedAt = new Date().toISOString();
  const now = Date.now();
  // ESPN's date parameter is a US calendar day, so cover a day either side of UTC today.
  const days = [-1, 0, 1, 2, 3].map((d) => new Date(now + d * 86400000).toISOString().slice(0, 10).replaceAll("-", ""));
  let boards: EspnBoard[];
  try {
    boards = await Promise.all(
      days.map(async (d) => {
        const res = await fetch(`${ESPN_NHL_SCOREBOARD}?dates=${d}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
        return res.json();
      }),
    );
  } catch (e) {
    return { ok: false, message: `Couldn't reach ESPN: ${e instanceof Error ? e.message : "unknown error"}.` };
  }

  const incoming = new Map<number, NhlMarket>();
  for (const board of boards) {
    for (const ev of board?.events ?? []) {
      if (ev?.status?.type?.state !== "pre") continue;
      const o = ev?.competitions?.[0]?.odds?.[0];
      if (!o) continue;
      incoming.set(-(Number(ev.id) + NHL_GAME_ID_OFFSET), parseEspnMarket(o, fetchedAt));
    }
  }

  const { data: rows, error } = await supabaseAdmin.from("nhl_predictions").select("game_id, market").in("game_id", [...incoming.keys()]);
  if (error) return { ok: false, message: error.message };

  let changed = 0;
  const failures: string[] = [];
  await Promise.all(
    (rows ?? []).map(async (r) => {
      const next = incoming.get(r.game_id as number)!;
      const prev = (r.market ?? null) as NhlMarket | null;
      const same = prev && (Object.keys(next) as (keyof NhlMarket)[]).every((k) => k === "fetched_at" || prev[k] === next[k]);
      if (!same) changed++;
      const { error: upErr } = await supabaseAdmin.from("nhl_predictions").update({ market: { ...(prev ?? {}), ...next } }).eq("game_id", r.game_id);
      if (upErr) failures.push(upErr.message);
    }),
  );
  if (failures.length > 0) return { ok: false, message: `Some updates failed: ${failures[0]}` };

  revalidatePath("/nhl");
  const n = rows?.length ?? 0;
  if (n === 0) return { ok: true, message: "No upcoming published games have DraftKings lines on ESPN yet." };
  return { ok: true, message: `DraftKings odds updated for ${n} games (${changed} had moved).` };
}

/** Locks in the confirmed starting goalies for one NHL game and re-simulates it right away (about a second -
 * the saved inputs in sim_params are replayed with the chosen goalies, see nhlSim.ts).
 * For each side: a goalie id to lock, 0 = someone not in the list (simulated as a league-average goalie), or
 * null = no lock (back to ESPN's call / our estimate). The lock is also saved to nhl_goalie_locks so every later
 * refresh (which re-fits everything) keeps respecting it. */
export async function setNhlGoalies(gameId: number, home: number | null, away: number | null): Promise<{ ok: boolean; message: string }> {
  const { data: row, error } = await supabaseAdmin.from("nhl_predictions").select("*").eq("game_id", gameId).maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (!row) return { ok: false, message: "There's no prediction for this game yet." };
  const pred = row as NhlPrediction;
  const sp = pred.sim_params;
  if (!sp) return { ok: false, message: "This prediction predates goalie locking - run Refresh model once, then try again." };

  const { data: game } = await supabaseAdmin.from("games").select("start_date, completed").eq("id", gameId).maybeSingle();
  if (!game || game.completed || new Date(game.start_date).getTime() <= Date.now()) {
    return { ok: false, message: "This game has already started, so its prediction is frozen." };
  }

  const resolve = (key: "home" | "away", lockId: number | null): { goalies: NhlGoalie[]; source: GoalieSource; confirmed: boolean } => {
    if (lockId === null) return sp.estimated[key];
    if (lockId === 0) return { goalies: [{ id: null, name: "Other (league-average goalie)", weight: 1, rating: 0 }], source: "locked", confirmed: true };
    const g = sp.pool[key].find((p) => p.id === lockId);
    return { goalies: [{ id: lockId, name: g?.name ?? `Goalie ${lockId}`, weight: 1, rating: g?.rating ?? 0 }], source: "locked", confirmed: true };
  };
  const h = resolve("home", home);
  const a = resolve("away", away);

  // the lock first - if its table isn't there yet, say so before touching the prediction
  const lockWrite =
    home === null && away === null
      ? await supabaseAdmin.from("nhl_goalie_locks").delete().eq("game_id", gameId)
      : await supabaseAdmin
          .from("nhl_goalie_locks")
          .upsert({ game_id: gameId, home_goalie_id: home, away_goalie_id: away, locked_at: new Date().toISOString() }, { onConflict: "game_id" });
  if (lockWrite.error) {
    const missing = /schema cache|does not exist/i.test(lockWrite.error.message);
    return { ok: false, message: missing ? "The goalie-locks table doesn't exist yet - run the new SQL migration first." : lockWrite.error.message };
  }

  const toScenario = (g: NhlGoalie): GoalieScenario => ({ rating: g.rating, weight: g.weight });
  const sim = simulateGame(sp.rates, sp.tables, h.goalies.map(toScenario), a.goalies.map(toScenario), 40000, Math.abs(gameId) % 1000003);
  const assumptions = {
    ...pred.assumptions,
    goalies: { home: h.goalies, away: a.goalies },
    goalie_confirmed: h.confirmed && a.confirmed,
    sources: { home: h.source, away: a.source },
    confirmed: { home: h.confirmed, away: a.confirmed },
    pool: sp.pool,
  };
  const { error: updateError } = await supabaseAdmin.from("nhl_predictions").update({ ...sim, assumptions }).eq("game_id", gameId);
  if (updateError) return { ok: false, message: updateError.message };

  revalidatePath(`/nhl/games/${gameId}`);
  revalidatePath("/nhl");
  const locked = [home, away].filter((x) => x !== null).length;
  return { ok: true, message: locked === 0 ? "Back to the estimate - re-simulated." : `Locked ${locked} goalie${locked === 1 ? "" : "s"} - re-simulated.` };
}
