import { supabase } from "./supabase";
import { type Discovery, getDiscoveries, pageAll } from "./syndicates";

// The Ratings Panel scoreboard: each outside rating system's own margin and total (KenPom, Torvik, EvanMiya, and their average) against what DraftKings posted first, what it closed at, and what happened.
// Two sources, both written by the engine: the line-discovery rows (when DraftKings first priced a game the exchange had been making a line on) and the finished games' closing record.

export type Nums = [number, number | null];
export type PanelNums = { avg?: Nums; kenpom?: Nums; torvik?: Nums; evanmiya?: Nums; asof?: string };
type PanelDiscovery = Discovery & { panel?: PanelNums | null };

export const SYSTEMS: [keyof PanelNums, string][] = [["kenpom", "KenPom"], ["torvik", "Torvik"], ["evanmiya", "EvanMiya"], ["avg", "Panel average"]];

/** Mean absolute miss and signed bias (prediction minus the target) over the pairs. */
export type Score = { n: number; mae: number | null; bias: number | null };
const score = (pairs: [number, number][]): Score => {
  const n = pairs.length;
  return n ? { n, mae: pairs.reduce((a, [p, t]) => a + Math.abs(p - t), 0) / n, bias: pairs.reduce((a, [p, t]) => a + (p - t), 0) / n } : { n: 0, mae: null, bias: null };
};

export type OpenRow = { key: string; label: string; margin: Score; total: Score };
export type CloseRow = { key: string; label: string; dkM: Score; dkT: Score; resM: Score; resT: Score };
export type PairRow = { id: string; pnl: number; n: number; qty: number };
/** One game DraftKings has opened: its first line next to every source's number (expected home margin and total). */
export type OpenGame = { id: string; teams: string; start: string; found: string; hours: number; dkSpread: number | null; dkTotal: number | null; dkM: number; dkT: number; backfilled: boolean; cells: Record<string, Nums | null> };
/** One game on offer now: the current line (DraftKings' if posted, else the exchange's own) next to the panel's numbers. */
export type Upcoming = { id: string; teams: string; start: string; src: string; m: number; t: number; line: [number | null, number | null]; nums: PanelNums };

export async function getPanelUpcoming(): Promise<{ ts: string | null; rows: Upcoming[] }> {
  const { data } = await supabase.from("ex_meta").select("value").eq("key", "panelgames").maybeSingle();
  const v = (data?.value ?? null) as { ts?: string; rows?: Upcoming[] } | null;
  return { ts: v?.ts ?? null, rows: v?.rows ?? [] };
}

export async function getPanelBoard(): Promise<{ open: OpenRow[]; openGames: OpenGame[]; close: CloseRow[]; pairs: PairRow[]; games: { open: number; close: number }; asof: string | null }> {
  const discs = ((await getDiscoveries()) as PanelDiscovery[]).filter((d) => d.dk && d.sport === "cbb");
  const withPanel = discs.filter((d) => d.panel);
  const open: OpenRow[] = [];
  const sources: [string, string, (d: PanelDiscovery) => Nums | null | undefined, PanelDiscovery[]][] = [
    ["seed", "Opening seed (before trading)", (d) => d.seed as Nums | null, withPanel],
    ["line", "Exchange line when DraftKings posted", (d) => d.internal as Nums | null, withPanel],
    ...SYSTEMS.map(([k, label]) => [k, label, (d: PanelDiscovery) => d.panel?.[k] as Nums | undefined, withPanel] as [string, string, (d: PanelDiscovery) => Nums | null | undefined, PanelDiscovery[]]),
  ];
  for (const [key, label, get, set] of sources) {
    const m: [number, number][] = [], t: [number, number][] = [];
    for (const d of set) {
      const v = get(d);
      if (!v) continue;
      m.push([v[0], d.dk[0]]);
      if (v[1] != null) t.push([v[1], d.dk[1]]);
    }
    open.push({ key, label, margin: score(m), total: score(t) });
  }

  const openGames: OpenGame[] = withPanel
    .map((d) => ({
      id: d.id, teams: d.teams, start: d.start, found: d.found, hours: d.hours_before, dkSpread: d.dk_line?.[0] ?? null, dkTotal: d.dk_line?.[1] ?? null, dkM: d.dk[0], dkT: d.dk[1],
      backfilled: Boolean((d as { panel_bf?: boolean }).panel_bf),
      cells: { line: (d.internal as Nums | null) ?? null, seed: (d.seed as Nums | null) ?? null, kenpom: d.panel?.kenpom ?? null, torvik: d.panel?.torvik ?? null, evanmiya: d.panel?.evanmiya ?? null, avg: d.panel?.avg ?? null },
    }))
    .sort((a, b) => b.found.localeCompare(a.found));

  type R = { id: string; home_score: number | null; away_score: number | null; closing: { lines?: [string, number][]; pan?: PanelNums; src?: string } | null };
  const results = (await pageAll<R>((from, to) => supabase.from("ex_results").select("id,home_score,away_score,closing").eq("sport", "cbb").order("day", { ascending: false }).range(from, to), 20000))
    .filter((r) => r.closing?.pan && (r.closing.src ?? "dk") === "dk" && r.home_score != null && r.away_score != null);
  const close: CloseRow[] = [];
  const cat = (pick: (r: R) => { pred: Nums | null | undefined; dk: Nums }): { dkM: [number, number][]; dkT: [number, number][]; resM: [number, number][]; resT: [number, number][] } => {
    const o = { dkM: [] as [number, number][], dkT: [] as [number, number][], resM: [] as [number, number][], resT: [] as [number, number][] };
    for (const r of results) {
      const { pred, dk } = pick(r);
      if (!pred) continue;
      const rm = r.home_score! - r.away_score!, rt = r.home_score! + r.away_score!;
      o.dkM.push([pred[0], dk[0]]); o.resM.push([pred[0], rm]);
      if (pred[1] != null && dk[1] != null) { o.dkT.push([pred[1], dk[1]]); o.resT.push([pred[1], rt]); }
    }
    return o;
  };
  const dkClose = (r: R): Nums => {
    const sp = r.closing?.lines?.find((l) => l[0] === "spread")?.[1], tt = r.closing?.lines?.find((l) => l[0] === "total")?.[1];
    return [sp != null ? -sp : NaN, tt ?? null];
  };
  for (const [k, label] of SYSTEMS) {
    const o = cat((r) => ({ pred: r.closing!.pan?.[k] as Nums | undefined, dk: dkClose(r) }));
    close.push({ key: k, label, dkM: score(o.dkM), dkT: score(o.dkT), resM: score(o.resM), resT: score(o.resT) });
  }
  const dk = cat((r) => ({ pred: dkClose(r), dk: dkClose(r) }));  // DraftKings' own close against the result: the bar every system is measured against
  close.push({ key: "dk", label: "DraftKings close", dkM: score([]), dkT: score([]), resM: score(dk.resM), resT: score(dk.resT) });

  // the panel's traders trading each other: the cleanest head-to-head, since both sides are the same size of stake and only the rating system differs
  type T = { buyer: string; seller: string; qty: number; price: number; outcome: number | null };
  const trades = await pageAll<T>((from, to) => supabase.from("ex_trades").select("buyer,seller,qty,price,outcome").like("buyer", "pan-%").like("seller", "pan-%").eq("settled", true).range(from, to), 20000);
  const byId: Record<string, PairRow> = {};
  for (const t of trades) {
    if (t.outcome == null || t.outcome === 0.5) continue;
    for (const [who, pnl] of [[t.buyer, t.qty * (t.outcome - t.price)], [t.seller, t.qty * (t.price - t.outcome)]] as [string, number][]) {
      const r = (byId[who] ??= { id: who, pnl: 0, n: 0, qty: 0 });
      r.pnl += pnl; r.n += 1; r.qty += t.qty;
    }
  }
  const asof = results.find((r) => r.closing?.pan?.asof)?.closing?.pan?.asof ?? withPanel.find((d) => d.panel?.asof)?.panel?.asof ?? null;
  return { open, openGames, close, pairs: Object.values(byId).sort((a, b) => a.id.localeCompare(b.id)), games: { open: withPanel.length, close: results.length }, asof };
}
