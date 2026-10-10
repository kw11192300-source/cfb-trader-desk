"use server";

import { revalidatePath } from "next/cache";
import { simulateGame, type GoalieScenario } from "@/lib/nhlSim";
import { recordModelSnapshot, updateNhlOdds, updateNhlScores } from "@/lib/nhlOdds";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { GoalieSource, NhlGoalie, NhlPrediction } from "@/lib/types";

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

/** Odds-only refresh behind the "Update DK odds" button: re-reads ESPN's DraftKings lines for upcoming games in a few
 * seconds, no model refit (the model's own numbers are untouched, so compare against it only until the next full refresh
 * changes lineups or ratings). The same update runs on a timer - see src/lib/nhlOdds.ts. */
export async function refreshNhlOdds(): Promise<{ ok: boolean; message: string }> {
  const r = await updateNhlOdds();
  if (r.ok) {
    revalidatePath("/nhl");
    revalidatePath("/nhl/edges");
  }
  return { ok: r.ok, message: r.ok && r.games > 0 ? `DraftKings odds updated for ${r.games} games (${r.moved} had moved).` : r.message };
}

/** Score refresh behind the "Update scores" button: pulls today's scores, live status and finals from ESPN right now (the
 * scheduled GitHub sync does the same, but only fires a few times a day), then grades any logged edges that just finished. */
export async function refreshNhlScores(): Promise<{ ok: boolean; message: string }> {
  const r = await updateNhlScores({ grade: true });
  if (r.ok) {
    revalidatePath("/nhl");
    revalidatePath("/nhl/bets");
    revalidatePath("/nhl/performance");
  }
  return { ok: r.ok, message: r.message };
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

  await recordModelSnapshot(gameId).catch(() => undefined); // marks the goalie change on the game's price chart
  revalidatePath(`/nhl/games/${gameId}`);
  revalidatePath("/nhl");
  const locked = [home, away].filter((x) => x !== null).length;
  return { ok: true, message: locked === 0 ? "Back to the estimate - re-simulated." : `Locked ${locked} goalie${locked === 1 ? "" : "s"} - re-simulated.` };
}
