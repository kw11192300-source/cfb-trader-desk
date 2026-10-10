import { espnCode } from "./nhlTeams";

// What the model does NOT know - gathered in one place so the board cards and the game page tell the same story. None of
// this feeds the simulation (apart from the goalie, which does): it is context for reading a model-vs-market gap.

export type InjuryStatus = "Out" | "Day-To-Day" | "IR" | "Suspension";

export type Injury = {
  name: string;
  position: string | null;
  status: InjuryStatus;
  type: string | null; // "Lower Body", "Upper Body", "Illness"...
  date: string; // when ESPN last updated this entry
  returnDate: string | null;
  comment: string | null;
};

export type NhlContext = {
  /** Injury list per team, keyed by ESPN's team code (see espnCode). */
  injuries: Record<string, Injury[]>;
  /** Start times of each team's nearby games (past and upcoming), keyed by full team name, sorted. */
  starts: Record<string, string[]>;
  /** Games played this season per team (from the last published team tables), keyed by full team name. */
  gp: Record<string, number>;
};

export const EMPTY_CONTEXT: NhlContext = { injuries: {}, starts: {}, gp: {} };

export type Rest = { daysRest: number | null; backToBack: boolean; gamesLast7: number };

/** Rest going into a game: calendar days since the team's previous game (0 = back-to-back), and games in the 7 days before. */
export function restInfo(ctx: NhlContext, team: string, startIso: string): Rest {
  const t = new Date(startIso).getTime();
  const prior = (ctx.starts[team] ?? []).map((s) => new Date(s).getTime()).filter((x) => x < t - 3 * 3600 * 1000);
  if (prior.length === 0) return { daysRest: null, backToBack: false, gamesLast7: 0 };
  const last = Math.max(...prior);
  // compare calendar days in US Eastern time, which is how hockey schedules read ("played last night")
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const diff = Math.round((new Date(day(t)).getTime() - new Date(day(last)).getTime()) / 86400000);
  const daysRest = Math.max(0, diff - 1);
  return { daysRest, backToBack: diff === 1, gamesLast7: prior.filter((x) => t - x <= 7 * 86400000).length };
}

export type Caution = { short: string; long: string };

type GoalieAssumptions = {
  confirmed?: { home?: boolean; away?: boolean };
  sources?: { home?: string; away?: string };
  goalies?: { home?: { name: string; weight: number }[]; away?: { name: string; weight: number }[] };
};

const nick = (team: string) => team.split(" ").slice(-1)[0];

/** Reasons to read this game's model numbers with extra care. Empty = nothing known that the model is missing. */
export function cautions(opts: {
  home: string;
  away: string;
  startIso: string;
  assumptions: GoalieAssumptions | null;
  ctx: NhlContext;
  /** |model - market| on the moneyline, in probability points, when DK lines exist. */
  mlGapPts: number | null;
}): Caution[] {
  const { home, away, startIso, assumptions, ctx, mlGapPts } = opts;
  const out: Caution[] = [];

  const unconfirmed = ([["away", away], ["home", home]] as const).filter(([side]) => assumptions && assumptions.confirmed?.[side] === false && assumptions.sources?.[side] !== "locked");
  if (unconfirmed.length > 0) {
    out.push({
      short: unconfirmed.length === 2 ? "goalies unconfirmed" : `${nick(unconfirmed[0][1])} goalie unconfirmed`,
      long: `${unconfirmed.map(([, t]) => t).join(" and ")}: the starting goalie isn't confirmed yet - the model is hedging across the likely starters.`,
    });
  }

  const b2b = [away, home].filter((t) => restInfo(ctx, t, startIso).backToBack);
  if (b2b.length > 0) {
    out.push({
      short: b2b.length === 2 ? "both back-to-back" : `${nick(b2b[0])} back-to-back`,
      long: `${b2b.join(" and ")} played last night - the backup often starts the second game, and fatigue isn't modeled.`,
    });
  }

  const gp = [away, home].map((t) => ctx.gp[t]).filter((n): n is number => typeof n === "number");
  if (gp.length > 0 && Math.min(...gp) < 10) {
    out.push({ short: "early season", long: `Only ${Math.min(...gp)} games played by one of these teams - ratings still lean heavily on last season, and roster changes aren't reflected.` });
  }

  const goalieOut: string[] = [];
  const uncertain: { team: string; list: Injury[] }[] = [];
  for (const team of [away, home]) {
    const list = ctx.injuries[espnCode(team) ?? ""] ?? [];
    // only a problem when the goalie the model is using is the one on the list (a backup on IR changes nothing)
    const side = team === home ? "home" : "away";
    const modeled = (assumptions?.goalies?.[side] ?? []).map((g) => g.name.toLowerCase());
    if (list.some((i) => i.position === "G" && modeled.includes(i.name.toLowerCase()))) goalieOut.push(team);
    const u = list.filter((i) => i.status === "Out" || i.status === "Day-To-Day");
    if (u.length > 0) uncertain.push({ team, list: u });
  }
  if (goalieOut.length > 0) {
    out.push({ short: "goalie injured", long: `${goalieOut.join(" and ")}: a goalie the model is using is on the injury list - check who is actually available.` });
  }
  if (uncertain.length > 0) {
    const n = uncertain.reduce((sum, u) => sum + u.list.length, 0);
    out.push({
      short: `injuries (${n})`,
      long: uncertain.map((u) => `${u.team}: ${u.list.map((i) => `${i.name} (${i.status === "Out" ? "out" : "day-to-day"})`).join(", ")}`).join(" - ") + " - the model assumes a full lineup.",
    });
  }

  if (mlGapPts !== null && mlGapPts >= 8) {
    out.push({ short: "far from the market", long: `The model's win probability is ${mlGapPts.toFixed(1)} points from DraftKings' - gaps this large are usually something it can't see.` });
  }
  return out;
}
