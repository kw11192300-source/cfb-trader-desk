import { supabase } from "./supabase";
import { type ExGame, type ExMark, type ExMember, type ExTrade, getDiscoveries, pageAll } from "./syndicates";

/** The most recent time that was `hourEt` o'clock US Eastern, at or before `now`. */
export function snapshotTime(hourEt: number, now = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
  const base = Math.floor(now.getTime() / 3600000) * 3600000;
  for (let h = 0; h < 49; h++) {
    const t = new Date(base - h * 3600000);
    if (Number(fmt.format(t)) % 24 === hourEt % 24) return t;
  }
  return new Date(base);
}

export type Who = { name: string; firm: string; w: number; sharp: number; drift: number | null; driftN: number };
export type Row = {
  game: string; sport: string; teams: string; start: string; live: boolean;
  kind: "spread" | "total" | "ml";
  /** DraftKings' line and fair price on the contract at the snapshot (null when it had not posted yet) and now */
  snap: { line: number; p: number } | null;
  /** when DraftKings first priced the game, if that was after the snapshot, and the line the exchange itself had made on it before then */
  postedAt: string | null;
  internal: number | null;
  /** how far the number is likely to travel before the close (points; not which way), from python/exchange/overnight.py's rule of thumb */
  expMove: number | null;
  postedH: number | null;
  /** the site's CBB movement model: the side it expects the number to move toward, how many points, and how old the board it came from is */
  mm: { side: string | null; clv: number | null; ageH: number } | null;
  now: { line: number; p: number; x: number | null };
  sameLine: boolean;
  /** how far the market's number moved toward the home side / the over (points), and how far DraftKings' fair price on the same contract moved (price) */
  lineMove: number | null;
  pMove: number | null;
  /** exchange price minus DraftKings' price now, on the same contract */
  gap: number | null;
  /** since the snapshot: contracts traded, by whom, and the sharp-weighted net (positive = home / over / home win) */
  tradedQ: number; sharpQ: number; publicQ: number; netW: number; who: Who[];
  score: number;
};

const SCALE: Record<string, number> = { spread: 1, total: 2, ml: 0.03 };
const sharpScore = (m: ExMember, sport: string) => (m.params.public ? 0 : Number((m.stats.sharp ?? {})[sport] ?? 0));

/** Every main line of the games still to play, with what DraftKings and the exchange did since the snapshot and where the accounts with a closing record have been trading. */
export async function getOvernight(since: Date, members: ExMember[], horizonHours = 36): Promise<{ rows: Row[]; games: number; posted: number; newlyPosted: number }> {
  const now = new Date();
  const lo = new Date(now.getTime() - 60 * 60000).toISOString(), hi = new Date(Math.min(now.getTime() + horizonHours * 3600000, since.getTime() + (horizonHours + 12) * 3600000)).toISOString();
  const { data } = await supabase.from("ex_games").select("id,sport,start_utc,state,completed,home,away,ref,book,views").gte("start_utc", lo).lte("start_utc", hi).eq("completed", false);
  const games = ((data ?? []) as ExGame[]).filter((g) => g.ref && (g.ref.src ?? "dk") === "dk");
  if (!games.length) return { rows: [], games: 0, posted: 0, newlyPosted: 0 };
  const ids = games.map((g) => g.id);
  const from = new Date(since.getTime() - 40 * 60000).toISOString();
  const disc = Object.fromEntries((await getDiscoveries()).map((d) => [d.id, d]));
  const siteId = (gid: string) => { const [s, e] = gid.split(":"); return s === "cbb" && /^\d+$/.test(e) ? -(7_000_000_000 + Number(e)) : null; };
  const sids = games.map((g) => siteId(g.id)).filter((x): x is number => x != null);
  const { data: brd } = sids.length ? await supabase.from("cbb_game_board").select("game_id,updated_at,payload").in("game_id", sids) : { data: [] };
  const board = Object.fromEntries(((brd ?? []) as { game_id: number; updated_at: string; payload: { bets?: Record<string, { side?: string; clv?: number }> } }[]).map((b) => [b.game_id, b]));
  const [marks, trades] = await Promise.all([
    pageAll<ExMark>((a, b) => supabase.from("ex_marks").select("ts,game_id,lines,r,e").in("game_id", ids).gte("ts", from).order("ts", { ascending: true }).range(a, b)),
    pageAll<ExTrade>((a, b) => supabase.from("ex_trades").select("id,ts,game_id,kind,line,price,qty,buyer,seller,maker").in("game_id", ids).gte("ts", since.toISOString()).order("ts", { ascending: true }).order("id").range(a, b)),
  ]);
  const byMember = Object.fromEntries(members.map((m) => [m.id, m]));
  const marksOf: Record<string, ExMark[]> = {};
  for (const m of marks) (marksOf[m.game_id] ??= []).push(m);
  const tradesOf: Record<string, ExTrade[]> = {};
  for (const t of trades) (tradesOf[t.game_id] ??= []).push(t);
  const synOf = (m: ExMember) => m.syndicate_id;

  const rows: Row[] = [];
  let posted = 0, newlyPosted = 0;
  for (const g of games) {
    const ms = marksOf[g.id] ?? [];
    if (!ms.length) continue;
    const found = disc[g.id]?.found && disc[g.id].found > since.toISOString() ? disc[g.id] : null; // DraftKings priced it after the snapshot: before that the line on it was the exchange's own
    const snapMark = found ? null : [...ms].filter((m) => m.ts <= since.toISOString()).pop() ?? null;
    const last = ms[ms.length - 1];
    posted += 1;
    if (!snapMark) newlyPosted += 1;
    const flowFrom = found ? found.found : since.toISOString();
    for (const kind of ["spread", "total", "ml"] as const) {
      const li = last.lines.findIndex((x) => x[0] === kind);
      if (li < 0) continue;
      const nowLine = last.lines[li][1], nowP = last.r[li], nowX = last.e ? last.e[li] : null;
      const si = snapMark ? snapMark.lines.findIndex((x) => x[0] === kind) : -1;
      const snap = snapMark && si >= 0 ? { line: snapMark.lines[si][1], p: snapMark.r[si] } : null;
      const sameLine = !!snap && snap.line === nowLine;
      // movement in the home / over direction: the spread number is the home spread, so a smaller number means the market moved toward the home side
      const lineMove = snap == null ? null : kind === "spread" ? snap.line - nowLine : kind === "total" ? nowLine - snap.line : null;
      const pMove = snap && sameLine ? nowP - snap.p : kind === "ml" && snap ? nowP - snap.p : null;
      const gap = nowX == null ? null : nowX - nowP;
      // flow since the snapshot on this kind of market
      let tradedQ = 0, sharpQ = 0, publicQ = 0, netW = 0;
      const who: Record<string, Who> = {};
      for (const t of tradesOf[g.id] ?? []) {
        if (t.kind !== kind || t.ts < flowFrom) continue;
        tradedQ += t.qty;
        const taker = t.maker === t.seller ? t.buyer : t.seller;
        const m = byMember[taker];
        if (!m) continue;
        if (m.params.public) { publicQ += t.qty; continue; }
        if (m.params.lab) continue;
        const s = sharpScore(m, g.sport);
        if (s < 0.3) continue;
        const dir = taker === t.buyer ? 1 : -1;
        sharpQ += t.qty;
        netW += dir * t.qty * s;
        const w = (who[taker] ??= { name: m.name, firm: synOf(m), w: 0, sharp: s, drift: m.stats.drift_taker_n ? (m.stats.drift_taker_sum ?? 0) / m.stats.drift_taker_n : null, driftN: m.stats.drift_taker_n ?? 0 });
        w.w += dir * t.qty * s;
      }
      const dsc = disc[g.id];
      const postedH = dsc ? (now.getTime() - new Date(dsc.found).getTime()) / 3600000 : null;
      const gapInt = dsc && kind !== "ml" ? (() => { const a = dsc.int_line[kind === "spread" ? 0 : 1], b = dsc.dk_line[kind === "spread" ? 0 : 1]; return a == null || b == null ? null : a - b; })() : null;
      const expMove = kind === "ml" ? null : expectedMove(g.sport, kind, (g.views as { tier?: string } | null)?.tier ?? null, nowLine, gapInt, postedH);
      const bd = board[siteId(g.id) ?? 0];
      const bet = bd && kind !== "ml" ? bd.payload?.bets?.[kind] : undefined;
      const mm = bd && kind !== "ml" ? { side: bet?.side ?? null, clv: bet?.clv ?? null, ageH: (now.getTime() - new Date(bd.updated_at).getTime()) / 3600000 } : null;
      const score = Math.abs(lineMove ?? 0) / SCALE[kind] + Math.abs(pMove ?? 0) / 0.02 + Math.abs(gap ?? 0) / 0.01 + Math.abs(netW) / 60 + (snap == null ? 0.5 : 0);
      rows.push({
        game: g.id, sport: g.sport, teams: `${g.away.abbr} @ ${g.home.abbr}`, start: g.start_utc, live: g.state !== "pre", kind, snap,
        postedAt: found ? found.found : null, internal: found && kind !== "ml" ? found.int_line[kind === "spread" ? 0 : 1] : null, now: { line: nowLine, p: nowP, x: nowX }, sameLine,
        lineMove, pMove, gap, expMove, postedH, mm, tradedQ, sharpQ, publicQ, netW, who: Object.values(who).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 3), score,
      });
    }
  }
  return { rows, games: games.length, posted, newlyPosted };
}

const BASE: Record<string, number> = { "cbb|spread": 2.0, "cbb|total": 2.6, "cfb|spread": 1.1, "cfb|total": 1.6, "nba|spread": 0.9, "nba|total": 1.9, "nfl|spread": 1.0, "nfl|total": 1.5 };
/** The same rule of thumb the nightly snapshot stores (python/exchange/overnight.py expected_move): the average size of the move from two hours after DraftKings posts a line to the close,
 * scaled for the lowest college basketball tier, big spreads, mid-range totals and a wide gap to the exchange's own line, and down a little for every hour since the line went up. */
export function expectedMove(sport: string, kind: string, tier: string | null, level: number | null, gapInt: number | null, hrsSince: number | null): number | null {
  const base = BASE[`${sport}|${kind}`];
  if (base == null) return null;
  let m = 1;
  if (sport === "cbb" && tier === "CC") m *= 1.2;
  if (level != null) {
    if (kind === "spread" && Math.abs(level) >= 15) m *= 1.2;
    if (kind === "total") m *= level >= 140 && level < 155 ? 1.2 : level < 140 ? 0.8 : 1;
  }
  if (gapInt != null) {
    const g = Math.abs(gapInt);
    m *= g >= 6 ? (kind === "spread" ? 1.3 : 1.5) : g < 2 && kind === "spread" ? 0.7 : 1;
  }
  m *= Math.max(0.65, 1 - 0.025 * (hrsSince ?? 8));
  return Math.round(base * m * 100) / 100;
}

export type NightRow = {
  game: string; sport: string; teams: string; kind: string; line: number; flow: number; exp_move: number | null; mm?: { side: string | null; clv: number | null; age_h: number };
  done?: boolean; void?: boolean; move?: number; y?: number;
};
export type Night = { key: string; date: string; ts: string; scored: boolean; rows: NightRow[] };
/** The saved evening snapshots, newest first, with whatever has been scored. */
export async function getNights(limit = 14): Promise<Night[]> {
  const { data } = await supabase.from("ex_meta").select("key,value").like("key", "overnight:%").order("key", { ascending: false }).limit(limit);
  return ((data ?? []) as { key: string; value: { date: string; ts: string; scored: boolean; rows: NightRow[] } }[]).map((r) => ({ key: r.key, date: r.value.date, ts: r.value.ts, scored: r.value.scored, rows: r.value.rows ?? [] }));
}

/** How the saved snapshots did, row by row: a sharp lean, a movement-model call, and the volatility rank. Positive "toward" means the number moved the way it was called. */
export function scoreNights(nights: Night[]) {
  const dirOf = (r: NightRow, positive: boolean) => (r.kind === "total" ? (positive ? "over" : "under") : positive ? "home" : "away");
  const acc = { lean: { n: 0, toward: 0, pts: 0 }, mm: { n: 0, toward: 0, pts: 0 }, top: { n: 0, abs: 0 }, rest: { n: 0, abs: 0 }, scored: 0, rows: 0 };
  const perNight = nights.map((nt) => {
    const done = nt.rows.filter((r) => r.done && !r.void && r.move != null && r.kind !== "ml");
    const rank = [...done].filter((r) => r.exp_move != null).sort((a, b) => (b.exp_move ?? 0) - (a.exp_move ?? 0));
    const top = rank.slice(0, 8), rest = rank.slice(8);
    const lean = done.filter((r) => Math.abs(r.flow) >= 40);
    const mmr = done.filter((r) => r.mm && r.mm.side && (r.mm.clv ?? 0) >= 0.5);
    const rec = { date: nt.date, rows: nt.rows.length, scored: done.length, lean: { n: 0, toward: 0, pts: 0 }, mm: { n: 0, toward: 0, pts: 0 }, topAbs: top.length ? top.reduce((a, r) => a + Math.abs(r.move!), 0) / top.length : null, restAbs: rest.length ? rest.reduce((a, r) => a + Math.abs(r.move!), 0) / rest.length : null };
    for (const r of lean) { const s = Math.sign(r.flow) * r.move!; rec.lean.n++; rec.lean.pts += s; rec.lean.toward += s > 0.001 ? 1 : 0; }
    for (const r of mmr) { const pos = r.mm!.side === "home" || r.mm!.side === "over"; const s = (pos ? 1 : -1) * r.move!; rec.mm.n++; rec.mm.pts += s; rec.mm.toward += s > 0.001 ? 1 : 0; }
    acc.lean.n += rec.lean.n; acc.lean.toward += rec.lean.toward; acc.lean.pts += rec.lean.pts;
    acc.mm.n += rec.mm.n; acc.mm.toward += rec.mm.toward; acc.mm.pts += rec.mm.pts;
    for (const r of top) { acc.top.n++; acc.top.abs += Math.abs(r.move!); }
    for (const r of rest) { acc.rest.n++; acc.rest.abs += Math.abs(r.move!); }
    acc.scored += done.length; acc.rows += nt.rows.length;
    return rec;
  });
  void dirOf;
  return { acc, perNight };
}
