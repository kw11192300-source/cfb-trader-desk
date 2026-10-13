import { americanToProb } from "./nhlModel";

/** A saved odds snapshot reduced to what the goalie-news test needs (the model's win probability is pulled out in SQL). */
export type NewsSnapshot = {
  game_id: number;
  captured_at: string;
  ml_home: number | null;
  ml_away: number | null;
  model_note: string | null;
  p_home: number | null;
};

export type NewsGame = { id: number; home_team: string; away_team: string; start_date: string };

/** One goalie-news update (a goalie confirmed, or the expected starter switched) and how DraftKings reacted around it. */
export type NewsEvent = {
  key: string;
  at: string;
  gameId: number;
  startDate: string;
  home: string;
  away: string;
  note: string;
  /** True when the starter changed from who we had expected (the note shows "A → B"). */
  isSwitch: boolean;
  /** How far the news moved OUR home win probability, in points. */
  modelMove: number;
  /** DK's change over the hour BEFORE we re-priced (points) - did the market already know? */
  dkBefore: number;
  /** DK's no-vig home probability change in the same ~10-minute window (points). */
  dkSame: number;
  /** DK's change over the next hour after we re-priced (points); null when the game started inside that hour. */
  dkAfter: number | null;
  /** Our number minus DK's right after we re-priced (points, home side). */
  gap: number;
};

const fair = (h: number | null, a: number | null): number | null => {
  if (h === null || a === null) return null;
  const ph = americanToProb(h);
  const pa = americanToProb(a);
  return ph / (ph + pa);
};

/** Finds every goalie-news update in the snapshot history and measures it. */
export function goalieNewsEvents(snaps: NewsSnapshot[], games: NewsGame[]): NewsEvent[] {
  const gameById = new Map(games.map((g) => [g.id, g]));
  const byGame = new Map<number, NewsSnapshot[]>();
  for (const s of snaps) {
    const l = byGame.get(s.game_id);
    if (l) l.push(s);
    else byGame.set(s.game_id, [s]);
  }

  const out: NewsEvent[] = [];
  for (const [gameId, list] of byGame) {
    const game = gameById.get(gameId);
    if (!game) continue;
    list.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
    const start = new Date(game.start_date).getTime();

    // carry the model's probability forward: it is only saved on snapshots where it changed
    const model: (number | null)[] = [];
    let cur: number | null = null;
    for (const s of list) {
      if (s.p_home !== null) cur = s.p_home;
      model.push(cur);
    }

    for (let i = 1; i < list.length; i++) {
      const note = list[i].model_note;
      if (!note || !(note.includes("confirmed") || note.includes("→"))) continue;
      const mPrev = model[i - 1];
      const mNow = model[i];
      const dkNow = fair(list[i].ml_home, list[i].ml_away);
      const dkPrev = fair(list[i - 1].ml_home, list[i - 1].ml_away);
      if (mPrev === null || mNow === null || dkNow === null || dkPrev === null) continue;

      const t = new Date(list[i].captured_at).getTime();
      // the price an hour before we re-priced: the latest snapshot at or before then (the earliest one if none is that old)
      let base = fair(list[0].ml_home, list[0].ml_away);
      for (let j = 0; j < i; j++) {
        if (new Date(list[j].captured_at).getTime() > t - 3_600_000) break;
        const f = fair(list[j].ml_home, list[j].ml_away);
        if (f !== null) base = f;
      }
      let dkAfter: number | null = null;
      if (start - t > 3_600_000) {
        // snapshots are only saved when something moved, so none in the next hour means DK did not move
        let last = dkNow;
        for (let j = i + 1; j < list.length; j++) {
          if (new Date(list[j].captured_at).getTime() > t + 3_600_000) break;
          const f = fair(list[j].ml_home, list[j].ml_away);
          if (f !== null) last = f;
        }
        dkAfter = (last - dkNow) * 100;
      }
      out.push({
        key: `${gameId}-${list[i].captured_at}`,
        at: list[i].captured_at,
        gameId,
        startDate: game.start_date,
        home: game.home_team,
        away: game.away_team,
        note,
        isSwitch: note.includes("→"),
        modelMove: (mNow - mPrev) * 100,
        dkBefore: base === null ? 0 : (dkPrev - base) * 100,
        dkSame: (dkNow - dkPrev) * 100,
        dkAfter,
        gap: (mNow - dkNow) * 100,
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export type NewsSummary = {
  events: number;
  games: number;
  switches: number;
  avgMoveSwitch: number | null;
  avgMoveOther: number | null;
  /** Among updates that moved our number by at least `threshold` points: how DraftKings behaved. */
  threshold: number;
  meaningful: number;
  /** DraftKings had already moved our way in the hour before we re-priced (it knew first). */
  dkLed: number;
  dkWithUs: number;
  dkLater: number;
  dkNoMove: number;
};

export function summarizeNews(rows: NewsEvent[], threshold = 0.5): NewsSummary {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const sw = rows.filter((r) => r.isSwitch);
  const other = rows.filter((r) => !r.isSwitch);
  const big = rows.filter((r) => Math.abs(r.modelMove) >= threshold);
  let dkLed = 0;
  let dkWithUs = 0;
  let dkLater = 0;
  let dkNoMove = 0;
  for (const r of big) {
    const dir = Math.sign(r.modelMove);
    if (Math.sign(r.dkBefore) === dir && Math.abs(r.dkBefore) >= 0.2) dkLed++;
    else if (Math.sign(r.dkSame) === dir && Math.abs(r.dkSame) >= 0.2) dkWithUs++;
    else if (r.dkAfter !== null && Math.sign(r.dkAfter) === dir && Math.abs(r.dkAfter) >= 0.2) dkLater++;
    else dkNoMove++;
  }
  return {
    events: rows.length,
    games: new Set(rows.map((r) => r.gameId)).size,
    switches: sw.length,
    avgMoveSwitch: avg(sw.map((r) => Math.abs(r.modelMove))),
    avgMoveOther: avg(other.map((r) => Math.abs(r.modelMove))),
    threshold,
    meaningful: big.length,
    dkLed,
    dkWithUs,
    dkLater,
    dkNoMove,
  };
}
