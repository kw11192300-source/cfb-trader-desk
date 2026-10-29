import { supabase } from "./supabase";

// The Syndicates exchange is paper-only and keeps to its own ex_ tables (supabase/schema.sql); nothing else in the site reads or writes them.

export type ExSyndicate = {
  id: string;
  name: string;
  engine: string;
  color: string;
  tagline: string;
  start_units: number;
  /** w: how much of its own model each sport's fair price uses, learned from settled games */
  learn: {
    w?: Record<string, number>;
    stats?: Record<string, { n: number }>;
    calib?: Record<string, { model: [number, number][]; market: [number, number][] }>;
    agent?: {
      lines?: boolean;
      version?: number;
      notes?: string;
      published_at?: string;
      error?: string | null;
      backtest?: Record<string, { n?: number; coverage?: number; model?: { margin_mae: number | null; total_mae: number | null }; elo?: { margin_mae: number | null }; ridge?: { margin_mae: number | null; total_mae: number | null }; skipped?: string; error?: string }> | null;
    };
  } | null;
};
export type ExMemberStats = {
  n_maker: number;
  n_taker: number;
  vol_maker: number;
  vol_taker: number;
  pnl_maker: number;
  pnl_taker: number;
  clv_sum: number;
  clv_sq?: number;
  clv_n: number;
  peak: number;
  max_dd: number;
  wins: number;
  losses: number;
  biggest: number;
  /** how much other traders should listen to this one's hits, 0 to 1, by sport */
  sharp?: Record<string, number>;
  /** its record as a taker: decayed sum of closing-line value (s), weight (w), trades (n), by sport */
  flow?: Record<string, { s: number; w: number; n: number }>;
  /** spread captured by this trader's quotes against DraftKings at the moment of each fill: sum of qty x capture, and contracts */
  cap_sum?: number;
  cap_q?: number;
};
export type ExMember = {
  id: string;
  syndicate_id: string;
  name: string;
  role: "maker" | "taker" | "both";
  staking: string;
  params: Record<string, number | string[] | (string | number)[][]>;
  start_units: number;
  cash: number;
  locked: number;
  realized: number;
  equity: number | null;
  open_risk: number | null;
  stats: ExMemberStats;
};
export type ExTrade = {
  id: string;
  ts: string;
  round: number;
  game_id: string;
  kind: "ml" | "spread" | "total";
  line: number;
  price: number;
  qty: number;
  buyer: string;
  seller: string;
  maker: string;
  ref_p: number | null;
  rem_b: number | null;
  rem_s: number | null;
  settled: boolean;
  outcome: number | null;
  close_p: number | null;
};
type Team = { id: string; name: string; abbr: string };
export type ExGame = {
  id: string;
  sport: string;
  start_utc: string;
  state: string;
  completed: boolean;
  home: Team;
  away: Team;
  home_score: number | null;
  away_score: number | null;
  /** DraftKings' lines, or when DraftKings has not priced the game, a baseline (src is kalshi or model) built from Kalshi or our rating models */
  ref: { spread: number | null; total: number | null; ml_home: number | null; ml_away: number | null; src?: string } | null;
  /** [kind, line, reference %, best bid, best ask, last trade] */
  /** [kind, line, fair, best bid, best ask, last trade, first trade, bid size, ask size, exchange price] */
  book: [string, number, number, number | null, number | null, number | null, number | null, number | null, number | null, number | null, [number, number, string?][][] | null][] | null;
  ref_open: { spread: number | null; total: number | null; ml_home: number | null } | null;
  /** Kalshi's real-money prices in our contract terms: [kind, line, mid, bid, ask, volume] */
  views?: {
    kal?: [string, number, number, number, number, number][] | null;
    /** the three main lines [kind, line], DraftKings price for each, the exchange price, and each syndicate's own view */
    lines?: [string, number][];
    r?: number[];
    x?: (number | null)[];
    e?: Record<string, number[]>;
  } | null;
};
export type ExMark = { ts: string; game_id: string; lines: [string, number][]; r: number[]; e: (number | null)[] | null };
export type ExSnap = { ts: string; subject: string; equity: number };
export type ExMeta = { n: number; ts: string; markets: number; games: number; new_trades: number; settled: number; secs?: number; errors?: string[] } | null;
export type ExRatingsMeta = { ts: string; sports: string[] } | null;

/** The database returns at most 1,000 rows per request whatever limit is asked for, so anything that can pass that is read in pages. */
async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>, max = 30000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data } = await build(from, from + 999);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export const equityOf = (m: ExMember): number => m.equity ?? m.cash + m.locked;

export async function getExchange(): Promise<{ syndicates: ExSyndicate[]; members: ExMember[]; meta: ExMeta; ratingsMeta: ExRatingsMeta; configured: boolean }> {
  const [s, m, meta] = await Promise.all([
    supabase.from("ex_syndicates").select("*"),
    supabase.from("ex_members").select("*"),
    supabase.from("ex_meta").select("key,value"),
  ]);
  if (s.error || m.error) return { syndicates: [], members: [], meta: null, ratingsMeta: null, configured: false };
  const mv = Object.fromEntries(((meta.data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  return { syndicates: (s.data ?? []) as ExSyndicate[], members: (m.data ?? []) as ExMember[], meta: (mv.round ?? null) as ExMeta, ratingsMeta: (mv.ratings ?? null) as ExRatingsMeta, configured: true };
}

export async function getExchangeTrades(opts: { member?: string; syndicate?: string; limit?: number } = {}): Promise<ExTrade[]> {
  let q = supabase.from("ex_trades").select("*").order("ts", { ascending: false }).limit(opts.limit ?? 40);
  if (opts.member) q = q.or(`buyer.eq.${opts.member},seller.eq.${opts.member}`);
  else if (opts.syndicate) q = q.or(`buyer.like.${opts.syndicate}-%,seller.like.${opts.syndicate}-%`);
  const { data } = await q;
  return (data ?? []) as ExTrade[];
}

/** Games the exchange has seen (names, scores, book). Ids are ESPN ids, so they are looked up by the trades that mention them. */
export async function getExchangeGamesByIds(ids: string[]): Promise<Record<string, ExGame>> {
  if (!ids.length) return {};
  const { data } = await supabase.from("ex_games").select("id,sport,start_utc,state,completed,home,away,home_score,away_score").in("id", ids);
  return Object.fromEntries(((data ?? []) as ExGame[]).map((g) => [g.id, g]));
}

export async function getExchangeBoard(maxHours?: number): Promise<ExGame[]> {
  let q = supabase
    .from("ex_games")
    .select("id,sport,start_utc,state,completed,home,away,home_score,away_score,ref,ref_open,book,views")
    .eq("state", "pre")
    .not("book", "is", null)
    .order("start_utc", { ascending: true });
  if (maxHours) q = q.lte("start_utc", new Date(Date.now() + maxHours * 3600000).toISOString());
  const { data } = await q;
  return (data ?? []) as unknown as ExGame[];
}

export async function getExchangeSnapshots(subjectPrefix: string, days = 14): Promise<ExSnap[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return pageAll<ExSnap>((a, b) => supabase.from("ex_snapshots").select("ts,subject,equity").like("subject", `${subjectPrefix}%`).gte("ts", since).order("ts").order("id").range(a, b));
}

export function label(t: { kind: string; line: number }, g?: ExGame): string {
  const home = g?.home.abbr || g?.home.name || "Home";
  if (t.kind === "ml") return `${home} ML`;
  if (t.kind === "spread") return `${home} ${t.line > 0 ? "+" : ""}${t.line}`;
  return `Over ${t.line}`;
}

export const pct = (p: number | null | undefined): string => (p == null ? "–" : `${(p * 100).toFixed(0)}¢`);

export type Row = {
  id: string;
  name: string;
  syndicate: string;
  color: string;
  /** starting units plus profit actually banked (settled games and netted trades): cash and collateral, with open positions at cost */
  bankroll: number;
  /** what open positions would make or lose if closed at the DraftKings price now */
  open: number;
  /** bankroll plus open profit and loss */
  equity: number;
  pnl: number;
  realized: number;
  roi: number;
  openRisk: number;
  trades: number;
  volume: number;
  clv: number | null;
  /** standard error of the average CLV, when the spread is known */
  clvSe: number | null;
  clvN: number;
  /** average cents per contract the quotes captured against DraftKings when filled, or null if no quote has been filled */
  capture: number | null;
  makerPnl: number;
  takerPnl: number;
  maxDd: number;
  winRate: number | null;
  note: string;
};

function clvSe(sum: number, sq: number, n: number): number | null {
  if (n < 2 || sq <= 0) return null;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean) / n);
}

/** One summary row per member, and one per syndicate (its members added up), in the same shape so the same table renders both. */
export function summarize(syndicates: ExSyndicate[], members: ExMember[]): { members: Row[]; syndicates: Row[] } {
  const syn = Object.fromEntries(syndicates.map((s) => [s.id, s]));
  const rowOf = (id: string, name: string, syndicate: string, color: string, ms: ExMember[], start: number, note = ""): Row => {
    const equity = ms.reduce((a, m) => a + equityOf(m), 0);
    const bankroll = ms.reduce((a, m) => a + m.cash + m.locked, 0);
    const st = ms.map((m) => m.stats);
    const sum = (f: (s: ExMemberStats) => number) => st.reduce((a, s) => a + (f(s) ?? 0), 0);
    const volume = sum((s) => s.vol_maker + s.vol_taker);
    const clvN = sum((s) => s.clv_n);
    const decided = sum((s) => s.wins + s.losses);
    const realized = ms.reduce((a, m) => a + m.realized, 0);
    return {
      id, name, syndicate, color, bankroll, open: equity - bankroll, equity, pnl: equity - start, realized, roi: volume > 0 ? realized / volume : 0,
      openRisk: ms.reduce((a, m) => a + (m.open_risk ?? 0), 0), trades: sum((s) => s.n_maker + s.n_taker), volume,
      clv: clvN > 0 ? sum((s) => s.clv_sum) / clvN : null, clvSe: clvSe(sum((s) => s.clv_sum), sum((s) => s.clv_sq ?? 0), clvN), clvN, capture: sum((s) => s.cap_q ?? 0) > 0 ? sum((s) => s.cap_sum ?? 0) / sum((s) => s.cap_q ?? 0) : null, makerPnl: sum((s) => s.pnl_maker), takerPnl: sum((s) => s.pnl_taker),
      maxDd: Math.max(0, ...st.map((s) => s.max_dd)), winRate: decided > 0 ? sum((s) => s.wins) / decided : null, note,
    };
  };
  const mrows = members.map((m) => rowOf(m.id, m.name, syn[m.syndicate_id]?.name ?? m.syndicate_id, syn[m.syndicate_id]?.color ?? "#888", [m], m.start_units, `${m.role === "both" ? "maker + taker" : m.role} · ${Array.isArray(m.params.focus) ? (m.params.focus as string[]).map((x) => x.toUpperCase()).join(", ") : ""}`));
  const srows = syndicates.map((s) => rowOf(s.id, s.name, s.name, s.color, members.filter((m) => m.syndicate_id === s.id), s.start_units));
  return { members: mrows.sort((a, b) => b.pnl - a.pnl), syndicates: srows.sort((a, b) => b.pnl - a.pnl) };
}

export async function getGameTrades(gameId: string): Promise<ExTrade[]> {
  return pageAll<ExTrade>((a, b) => supabase.from("ex_trades").select("*").eq("game_id", gameId).order("ts", { ascending: true }).order("id").range(a, b));
}

export async function getGameMarks(gameId: string): Promise<ExMark[]> {
  return pageAll<ExMark>((a, b) => supabase.from("ex_marks").select("ts,game_id,lines,r,e").eq("game_id", gameId).order("ts", { ascending: true }).order("id").range(a, b));
}

export async function getExchangeGame(gameId: string): Promise<ExGame | null> {
  const { data } = await supabase.from("ex_games").select("*").eq("id", gameId).maybeSingle();
  return (data ?? null) as ExGame | null;
}

/** Trades from the last `hours`, for the top-traded views. */
export async function getRecentTrades(hours = 24): Promise<ExTrade[]> {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  return pageAll<ExTrade>((a, b) => supabase.from("ex_trades").select("id,ts,game_id,kind,line,price,qty,buyer,seller,maker").gte("ts", since).order("ts", { ascending: false }).order("id").range(a, b));
}

/** Profit and loss at each possible final margin (or total) for a set of trades, from one side of the market: positions still open only. */
export function payoff(trades: ExTrade[], who: (id: string) => string | null, xs: number[], dim: "m" | "t"): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const add = (key: string, qty: number, sign: 1 | -1, t: ExTrade) => {
    if (qty <= 1e-9) return;
    const isTotal = t.kind === "total";
    if ((dim === "t") !== isTotal) return;
    const arr = (out[key] ??= xs.map(() => 0));
    xs.forEach((x, i) => {
      const yes = t.kind === "ml" ? (x > 0 ? 1 : x < 0 ? 0 : 0.5) : t.kind === "spread" ? (x + t.line > 0 ? 1 : x + t.line < 0 ? 0 : 0.5) : x > t.line ? 1 : x < t.line ? 0 : 0.5;
      arr[i] += sign === 1 ? qty * (yes - t.price) : qty * (t.price - yes);
    });
  };
  for (const t of trades) {
    const b = who(t.buyer), s = who(t.seller);
    if (b) add(b, t.rem_b ?? t.qty, 1, t);
    if (s) add(s, t.rem_s ?? t.qty, -1, t);
  }
  return out;
}

/** The most of a game's risk limit that may be used this far from kickoff (mirrors python/exchange/engine.py ramp). */
export const ramp = (hours: number): number => (hours > 24 ? 0.15 : hours > 12 ? 0.3 : hours > 6 ? 0.5 : hours > 2 ? 0.75 : 1);
export const SYN_GAME_LIMIT = 150;
export const TRADER_GAME_LIMIT = 100;

export type Lot = { owner: string; holder: string; gid: string; kind: ExTrade["kind"]; line: number; qty: number; price: number };

/** Every position still open, one lot per side of each trade: positive qty is long the 'yes' side, negative is short. */
export function openLots(trades: ExTrade[], ownerOf: (memberId: string) => string | null): Lot[] {
  const out: Lot[] = [];
  for (const t of trades) {
    if (t.settled) continue;
    const b = ownerOf(t.buyer), s = ownerOf(t.seller);
    const rb = t.rem_b ?? t.qty, rs = t.rem_s ?? t.qty;
    if (b && rb > 1e-9) out.push({ owner: b, holder: t.buyer, gid: t.game_id, kind: t.kind, line: t.line, qty: rb, price: t.price });
    if (s && rs > 1e-9) out.push({ owner: s, holder: t.seller, gid: t.game_id, kind: t.kind, line: t.line, qty: -rs, price: t.price });
  }
  return out;
}

export function fairOf(g: ExGame | undefined, kind: string, line: number): number | null {
  const r = g?.book?.find((b) => b[0] === kind && b[1] === line);
  return r ? r[2] : null;
}

export async function getSyndicateOpenTrades(syndicate: string): Promise<ExTrade[]> {
  return pageAll<ExTrade>((a, b) => supabase.from("ex_trades").select("*").eq("settled", false).or(`buyer.like.${syndicate}-%,seller.like.${syndicate}-%`).order("ts", { ascending: false }).order("id").range(a, b));
}

export async function getGamesFull(ids: string[]): Promise<Record<string, ExGame>> {
  if (!ids.length) return {};
  const { data } = await supabase.from("ex_games").select("id,sport,start_utc,state,completed,home,away,home_score,away_score,ref,book").in("id", ids);
  return Object.fromEntries(((data ?? []) as ExGame[]).map((g) => [g.id, g]));
}

export async function getTraderOpenTrades(memberId: string): Promise<ExTrade[]> {
  return pageAll<ExTrade>((a, b) => supabase.from("ex_trades").select("*").eq("settled", false).or(`buyer.eq.${memberId},seller.eq.${memberId}`).order("ts", { ascending: false }).order("id").range(a, b));
}

/** The price history of the model-weight snapshots for a syndicate: sport -> [time, weight][] */
export async function getWeightHistory(syndicate: string, days = 30): Promise<Record<string, [number, number][]>> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const data = await pageAll<{ ts: string; subject: string; equity: number }>((a, b) => supabase.from("ex_snapshots").select("ts,subject,equity").like("subject", `w:${syndicate}:%`).gte("ts", since).order("ts").order("id").range(a, b));
  const out: Record<string, [number, number][]> = {};
  for (const r of data) (out[r.subject.split(":")[2]] ??= []).push([new Date(r.ts).getTime(), Number(r.equity)]);
  return out;
}

type Side = { pnl: number; traded: number; n: number; clv_sum: number; clv_n: number };
export type ExResult = {
  id: string;
  day: string;
  sport: string;
  kickoff: string;
  home: { id: string; name: string; abbr: string };
  away: { id: string; name: string; abbr: string };
  home_score: number | null;
  away_score: number | null;
  n_trades: number;
  contracts: number;
  traded: number;
  syn: Record<string, Side>;
  traders: Record<string, Side>;
  top: { taker: string; kind: string; line: number; price: number; qty: number; clv: number }[] | null;
};

/** Finished games' results, newest first. They are kept forever; the trades behind them are tidied away after a couple of weeks. */
export async function getResults(days = 30, sport?: string, withTraders = false): Promise<ExResult[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const cols = `id,day,sport,kickoff,home,away,home_score,away_score,n_trades,contracts,traded,syn,top${withTraders ? ",traders" : ""}`;
  const rows = await pageAll<ExResult>((a, b) => {
    let q = supabase.from("ex_results").select(cols).gte("day", since).order("kickoff", { ascending: false }).order("id").range(a, b);
    if (sport) q = q.eq("sport", sport);
    return q;
  });
  return rows.map((r) => ({ ...r, traders: r.traders ?? {} }));
}

export async function getResult(id: string): Promise<ExResult | null> {
  const { data } = await supabase.from("ex_results").select("*").eq("id", id).maybeSingle();
  return (data ?? null) as ExResult | null;
}

export type Digest = {
  day: string;
  games: number;
  contracts: number;
  traded: number;
  syndicates: { id: string; name: string; pnl: number; traded: number; trades: number; clv: number | null; clv_n: number }[];
  best_traders: { id: string; name: string; syn: string; pnl: number }[];
  worst_traders: { id: string; name: string; syn: string; pnl: number }[];
  sharp: { who: string; teams: string; game: string; kind: string; line: number; price: number; qty: number; clv: number }[];
  games_top: { id: string; teams: string; sport: string; score: string; contracts: number; winner: string | null; win_pnl: number }[];
  labs: { id: string; name: string; version: number; notes: string }[];
  weights: { name: string; sport: string; w: number }[];
};

export async function getDigests(n = 14): Promise<Digest[]> {
  const { data } = await supabase.from("ex_meta").select("key,value").like("key", "digest:%").order("key", { ascending: false }).limit(n);
  return ((data ?? []) as { value: Digest }[]).map((r) => r.value);
}

/** Every position still open, from the trade ledger of games that have not settled. */
export async function getAllOpenTrades(): Promise<ExTrade[]> {
  return pageAll<ExTrade>((a, b) => supabase.from("ex_trades").select("id,ts,game_id,kind,line,price,qty,buyer,seller,maker,rem_b,rem_s,settled").eq("settled", false).order("id").range(a, b));
}
