// NBA player props: the catalog (what you can log) and the box-score parsing/settling rules. Browser-safe (no database): the prop form
// imports the catalog; the server-side grader that uses it is in nbaProps.ts.
//
// A prop is logged as player + prop type + Over/Under (or Yes/No) + the line. Anything in the "stat" and "yes/no" groups below is
// graded automatically once the game is final, straight from the box score; the rest are settled by hand on the bets page. A
// player who did not play (did not play, or zero minutes) voids the bet - the usual sportsbook rule - and grades as a push.

export type PropGroup = "Single stat" | "Combo" | "Shooting" | "Yes / No" | "Manual";

export type PropDef = {
  label: string;
  group: PropGroup;
  /** Auto-gradable from the box score? */
  auto: boolean;
  /** Spellings that map to this prop (normalised: lower case, letters and digits only). */
  aliases: string[];
  /** For auto props: the value of the stat for one player. For Yes/No props: 1 = it happened. */
  calc?: (s: PlayerLine) => number;
};

export type PlayerLine = {
  min: number; pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; oreb: number; dreb: number; pf: number;
  fgm: number; fga: number; tpm: number; tpa: number; ftm: number; fta: number;
};

const cats = (s: PlayerLine) => [s.pts, s.reb, s.ast, s.stl, s.blk].filter((v) => v >= 10).length;

export const PROPS: PropDef[] = [
  { label: "Points", group: "Single stat", auto: true, aliases: ["points", "pts", "point"], calc: (s) => s.pts },
  { label: "Rebounds", group: "Single stat", auto: true, aliases: ["rebounds", "reb", "rebs", "rebound"], calc: (s) => s.reb },
  { label: "Assists", group: "Single stat", auto: true, aliases: ["assists", "ast", "asts", "assist"], calc: (s) => s.ast },
  { label: "3-Pointers Made", group: "Single stat", auto: true, aliases: ["3pointersmade", "3pm", "threes", "3s", "threepointersmade", "threepointers", "3pointers", "madethrees", "3ptmade", "3ptm"], calc: (s) => s.tpm },
  { label: "Steals", group: "Single stat", auto: true, aliases: ["steals", "stl", "stls", "steal"], calc: (s) => s.stl },
  { label: "Blocks", group: "Single stat", auto: true, aliases: ["blocks", "blk", "blks", "block", "blockedshots"], calc: (s) => s.blk },
  { label: "Turnovers", group: "Single stat", auto: true, aliases: ["turnovers", "to", "tov", "tos", "turnover"], calc: (s) => s.tov },
  { label: "Offensive Rebounds", group: "Single stat", auto: true, aliases: ["offensiverebounds", "oreb", "orebs", "offrebounds"], calc: (s) => s.oreb },
  { label: "Defensive Rebounds", group: "Single stat", auto: true, aliases: ["defensiverebounds", "dreb", "drebs", "defrebounds"], calc: (s) => s.dreb },
  { label: "Personal Fouls", group: "Single stat", auto: true, aliases: ["personalfouls", "fouls", "pf"], calc: (s) => s.pf },
  { label: "Minutes", group: "Single stat", auto: true, aliases: ["minutes", "min", "mins", "minutesplayed"], calc: (s) => s.min },
  { label: "Points + Rebounds", group: "Combo", auto: true, aliases: ["pointsrebounds", "pr", "ptsreb", "ptsrebs", "pointsandrebounds"], calc: (s) => s.pts + s.reb },
  { label: "Points + Assists", group: "Combo", auto: true, aliases: ["pointsassists", "pa", "ptsast", "pointsandassists"], calc: (s) => s.pts + s.ast },
  { label: "Rebounds + Assists", group: "Combo", auto: true, aliases: ["reboundsassists", "ra", "rebast", "reboundsandassists"], calc: (s) => s.reb + s.ast },
  { label: "Pts + Reb + Ast", group: "Combo", auto: true, aliases: ["ptsrebast", "pra", "pointsreboundsassists", "pointsreboundsandassists"], calc: (s) => s.pts + s.reb + s.ast },
  { label: "Steals + Blocks", group: "Combo", auto: true, aliases: ["stealsblocks", "stocks", "stlblk", "sb", "stealsandblocks"], calc: (s) => s.stl + s.blk },
  { label: "Fantasy Score (DraftKings)", group: "Combo", auto: true, aliases: ["fantasyscore", "fantasyscoredk", "fantasyscoredraftkings", "dkfantasy", "fantasypointsdk", "fantasypoints"], calc: (s) => s.pts + 1.25 * s.reb + 1.5 * s.ast + 2 * s.stl + 2 * s.blk - 0.5 * s.tov + 0.5 * s.tpm + (cats(s) >= 2 ? 1.5 : 0) + (cats(s) >= 3 ? 3 : 0) },
  { label: "Fantasy Score (FanDuel)", group: "Combo", auto: true, aliases: ["fantasyscorefd", "fantasyscorefanduel", "fdfantasy", "fantasypointsfd"], calc: (s) => s.pts + 1.2 * s.reb + 1.5 * s.ast + 3 * s.stl + 3 * s.blk - s.tov },
  { label: "Field Goals Made", group: "Shooting", auto: true, aliases: ["fieldgoalsmade", "fgmade", "fgm"], calc: (s) => s.fgm },
  { label: "Field Goals Attempted", group: "Shooting", auto: true, aliases: ["fieldgoalsattempted", "fgattempted", "fga", "fgattempts"], calc: (s) => s.fga },
  { label: "3-Pointers Attempted", group: "Shooting", auto: true, aliases: ["3pointersattempted", "3pa", "threepointersattempted", "3ptattempted", "3pattempted"], calc: (s) => s.tpa },
  { label: "Free Throws Made", group: "Shooting", auto: true, aliases: ["freethrowsmade", "ftmade", "ftm"], calc: (s) => s.ftm },
  { label: "Free Throws Attempted", group: "Shooting", auto: true, aliases: ["freethrowsattempted", "ftattempted", "fta", "ftattempts"], calc: (s) => s.fta },
  { label: "Double-Double", group: "Yes / No", auto: true, aliases: ["doubledouble", "dd"], calc: (s) => (cats(s) >= 2 ? 1 : 0) },
  { label: "Triple-Double", group: "Yes / No", auto: true, aliases: ["tripledouble", "td"], calc: (s) => (cats(s) >= 3 ? 1 : 0) },
  // settled by hand: the box score cannot tell us
  { label: "First Basket (player)", group: "Manual", auto: false, aliases: [] },
  { label: "First Team Basket", group: "Manual", auto: false, aliases: [] },
  { label: "Player 1st Quarter Points", group: "Manual", auto: false, aliases: [] },
  { label: "Player 1st Half Points", group: "Manual", auto: false, aliases: [] },
  { label: "Player 1st Quarter Rebounds / Assists", group: "Manual", auto: false, aliases: [] },
  { label: "Team Total", group: "Manual", auto: false, aliases: [] },
  { label: "1st Half Spread / Total / ML", group: "Manual", auto: false, aliases: [] },
  { label: "1st Quarter Spread / Total / ML", group: "Manual", auto: false, aliases: [] },
  { label: "Alternate Spread / Total", group: "Manual", auto: false, aliases: [] },
  { label: "Winning Margin", group: "Manual", auto: false, aliases: [] },
  { label: "Race to X Points", group: "Manual", auto: false, aliases: [] },
  { label: "Overtime (Yes/No)", group: "Manual", auto: false, aliases: [] },
  { label: "Team to Score First", group: "Manual", auto: false, aliases: [] },
  { label: "Player Head-to-Head", group: "Manual", auto: false, aliases: [] },
];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const byAlias = new Map<string, PropDef>();
for (const p of PROPS) {
  byAlias.set(norm(p.label), p);
  for (const a of p.aliases) byAlias.set(a, p);
}

/** The catalog entry for whatever the user typed as the prop type (null when it is not one we can grade). */
export function propDef(propType: string | null): PropDef | null {
  if (!propType) return null;
  return byAlias.get(norm(propType)) ?? null;
}

// ------------------------------------------------------------------------------------------------- box scores

type EspnAthlete = { athlete?: { id?: string; displayName?: string; shortName?: string }; stats?: string[]; didNotPlay?: boolean; reason?: string };
export type EspnBox = {
  boxscore?: { players?: { team?: { id?: string; displayName?: string }; statistics?: { labels?: string[]; athletes?: EspnAthlete[] }[] }[] };
};

export type BoxPlayer = { name: string; team: string; line: PlayerLine | null }; // null = did not play

const pair = (s: string | undefined): [number, number] => {
  const m = /^(\d+)-(\d+)$/.exec(String(s ?? "").trim());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
const n = (s: string | undefined): number => {
  const v = Number(String(s ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(v) ? v : 0;
};

export function parseBox(j: EspnBox): BoxPlayer[] {
  const out: BoxPlayer[] = [];
  for (const t of j.boxscore?.players ?? []) {
    const team = t.team?.displayName ?? "";
    for (const grp of t.statistics ?? []) {
      const labels = grp.labels ?? [];
      const ix = (l: string) => labels.indexOf(l);
      for (const a of grp.athletes ?? []) {
        const name = a.athlete?.displayName ?? "";
        if (!name) continue;
        const st = a.stats ?? [];
        if (a.didNotPlay || st.length === 0) {
          out.push({ name, team, line: null });
          continue;
        }
        const g = (l: string) => st[ix(l)];
        const [fgm, fga] = pair(g("FG"));
        const [tpm, tpa] = pair(g("3PT"));
        const [ftm, fta] = pair(g("FT"));
        const line: PlayerLine = {
          min: n(g("MIN")), pts: n(g("PTS")), reb: n(g("REB")), ast: n(g("AST")), stl: n(g("STL")), blk: n(g("BLK")), tov: n(g("TO")),
          oreb: n(g("OREB")), dreb: n(g("DREB")), pf: n(g("PF")), fgm, fga, tpm, tpa, ftm, fta,
        };
        out.push({ name, team, line: line.min > 0 ? line : null });
      }
    }
  }
  return out;
}

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g;
function nameKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Finds the player the user typed in a box score: exact name, else last name + first initial when that is unambiguous. */
export function findPlayer(players: BoxPlayer[], typed: string): BoxPlayer | null {
  const key = nameKey(typed);
  if (!key) return null;
  const exact = players.filter((p) => nameKey(p.name) === key);
  if (exact.length === 1) return exact[0];
  const parts = key.split(" ");
  const last = parts[parts.length - 1];
  const first = parts[0] ?? "";
  const cand = players.filter((p) => {
    const pk = nameKey(p.name).split(" ");
    return pk[pk.length - 1] === last && (parts.length === 1 || pk[0].startsWith(first[0] ?? ""));
  });
  return cand.length === 1 ? cand[0] : null;
}

/** Result of one prop against a stat value. */
export function settle(def: PropDef, side: string, line: number, value: number): "win" | "loss" | "push" {
  const s = side.trim().toLowerCase();
  if (def.group === "Yes / No") {
    const happened = value >= 1;
    if (s === "yes" || s === "over") return happened ? "win" : "loss";
    if (s === "no" || s === "under") return happened ? "loss" : "win";
  }
  if (value === line) return "push";
  const over = value > line;
  return s === "under" ? (over ? "loss" : "win") : over ? "win" : "loss";
}
