import { devig } from "./nhlModel";
import type { NhlModelDigest } from "./types";

/** A saved snapshot that carries a model digest (the model's state, saved only when it changed). */
export type ModelSnapshot = {
  game_id: number;
  captured_at: string;
  ml_home: number | null;
  ml_away: number | null;
  model: NhlModelDigest | null;
  model_note: string | null;
};

export type ModelGame = { id: number; home_team: string; away_team: string; start_date: string };

export type ModelMoveReason = "goalie" | "rerun";

export type ModelMoveRow = {
  key: string;
  at: string;
  gameId: number;
  startDate: string;
  home: string;
  away: string;
  /** Away, home, then the expected total - was/now in text. */
  lines: { label: string; was: string; now: string }[];
  /** Which team's win probability went up (null when the win probability barely changed). */
  toward: { label: string; team: string | null };
  /** Shift in the win probability toward that team, in points. */
  pts: number;
  /** Change in the expected total, in goals (signed). */
  totalDelta: number;
  /** Did our number move toward DraftKings' (the gap shrank) or away, at the prices of that moment. */
  vsBook: { closer: boolean; before: number; after: number } | null;
  reason: string;
  kind: ModelMoveReason;
};

const nick = (t: string) => t.split(" ").slice(-1)[0];
const meanOf = (dist: Record<string, number>) => Object.entries(dist).reduce((s, [k, v]) => s + Number(k) * v, 0);
const topGoalie = (g: { id: number | null; name: string; weight: number }[]) => [...g].sort((a, b) => b.weight - a.weight)[0];

/** The reason for a model change. The odds update writes a note when a goalie changed; for plain re-runs (a model refresh with
 * new ratings, lineups or injuries) the note is generic, so describe what the digests show instead. */
function reasonOf(note: string | null, prev: NhlModelDigest, cur: NhlModelDigest, home: string, away: string): { text: string; kind: ModelMoveReason } {
  if (note && !note.startsWith("Model re-run")) return { text: note, kind: "goalie" };
  const bits: string[] = [];
  for (const side of ["away", "home"] as const) {
    const p = topGoalie(prev.goalies[side]);
    const c = topGoalie(cur.goalies[side]);
    if (p && c && p.name === c.name && Math.abs(p.weight - c.weight) >= 0.05) {
      bits.push(`${nick(side === "home" ? home : away)}: ${c.name} ${Math.round(p.weight * 100)}% → ${Math.round(c.weight * 100)}% to start`);
    }
  }
  if (bits.length > 0) return { text: `Goalie odds shifted: ${bits.join(" · ")}`, kind: "goalie" };
  return { text: "Model refresh (ratings, lineups, injuries)", kind: "rerun" };
}

/** Every change in the model's numbers for each game, newest first. A game's first saved digest is its starting point (no
 * move); each later digest is diffed against the one before it. */
export function buildModelMoves(snaps: ModelSnapshot[], games: ModelGame[]): ModelMoveRow[] {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const byGame = new Map<number, ModelSnapshot[]>();
  for (const s of snaps) {
    if (!s.model) continue;
    const l = byGame.get(s.game_id);
    if (l) l.push(s);
    else byGame.set(s.game_id, [s]);
  }

  const out: ModelMoveRow[] = [];
  for (const [gameId, list] of byGame) {
    const game = gameById.get(gameId);
    if (!game) continue;
    list.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const home = nick(game.home_team);
    const away = nick(game.away_team);
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1].model as NhlModelDigest;
      const c = list[i].model as NhlModelDigest;
      const dHome = (c.p_home - p.p_home) * 100;
      const tPrev = meanOf(p.total_dist);
      const tNow = meanOf(c.total_dist);
      const dTotal = tNow - tPrev;
      if (Math.abs(dHome) < 0.05 && Math.abs(dTotal) < 0.005) continue;
      const toward =
        Math.abs(dHome) < 0.05
          ? { label: dTotal > 0 ? "Total up (more goals)" : "Total down (fewer goals)", team: null }
          : dHome > 0
            ? { label: home, team: game.home_team }
            : { label: away, team: game.away_team };

      let vsBook: ModelMoveRow["vsBook"] = null;
      const s = list[i];
      if (s.ml_home !== null && s.ml_away !== null && Math.abs(dHome) >= 0.05) {
        const dk = devig(s.ml_home, s.ml_away);
        const before = Math.abs(p.p_home - dk) * 100;
        const after = Math.abs(c.p_home - dk) * 100;
        vsBook = { closer: after < before, before, after };
      }
      const r = reasonOf(s.model_note, p, c, game.home_team, game.away_team);
      const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
      out.push({
        key: `${gameId}-${s.captured_at}`,
        at: s.captured_at,
        gameId,
        startDate: game.start_date,
        home: game.home_team,
        away: game.away_team,
        lines: [
          { label: away, was: pc(1 - p.p_home), now: pc(1 - c.p_home) },
          { label: home, was: pc(p.p_home), now: pc(c.p_home) },
          { label: "Total", was: tPrev.toFixed(2), now: tNow.toFixed(2) },
        ],
        toward,
        pts: Math.abs(dHome),
        totalDelta: dTotal,
        vsBook,
        reason: r.text,
        kind: r.kind,
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
