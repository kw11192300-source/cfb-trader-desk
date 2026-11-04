import { sideText } from "./positions";
import { supabase } from "./supabase";
import { type ExGame, getResults, pageAll } from "./syndicates";

export type HistLeg = { text: string; net: number; kind: string; line: number };
export type HistRow = {
  game: string; day: string; sport: string; kickoff: string; teams: string; score: string | null;
  staked: number; returned: number; pnl: number; roi: number | null; trades: number; legs: HistLeg[];
};

/** Every finished game a trader (or all five traders of a firm) traded in, newest first: what they put up, what came back, and the sides they held.
 * Staked is the units at risk on every trade made on the game (a buyer's price, a seller's one minus the price, added up), including positions netted off along the way, as in the result rows. */
export async function getGameHistory(entity: { kind: "trader" | "firm"; id: string; memberIds: string[] }, limit: number | null, sport: string | null = null): Promise<{ rows: HistRow[]; sports: string[]; total: { games: number; staked: number; returned: number; pnl: number } }> {
  const results = await getResults(120, undefined, true);
  const mine = results
    .map((r) => ({ r, s: entity.kind === "firm" ? r.syn[entity.id] : r.traders?.[entity.id] }))
    .filter((x) => x.s && x.s.n > 0)
    .sort((a, b) => b.r.kickoff.localeCompare(a.r.kickoff));
  const sports = [...new Set(mine.map((x) => x.r.sport))];
  const inSport = sport ? mine.filter((x) => x.r.sport === sport) : mine;
  const shown = limit == null ? inSport : inSport.slice(0, limit);
  const ids = shown.map((x) => x.r.id);
  const set = new Set(entity.memberIds);
  const list = entity.memberIds.join(",");
  type T = { game_id: string; kind: string; line: number; qty: number; buyer: string; seller: string };
  const trades: T[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    trades.push(...(await pageAll<T>((a, b) => supabase.from("ex_trades").select("game_id,kind,line,qty,buyer,seller").in("game_id", chunk).or(`buyer.in.(${list}),seller.in.(${list})`).order("id").range(a, b))));
  }
  const net: Record<string, Record<string, { kind: string; line: number; net: number }>> = {};
  for (const t of trades) {
    const k = `${t.kind}|${t.line}`;
    const row = ((net[t.game_id] ??= {})[k] ??= { kind: t.kind, line: t.line, net: 0 });
    if (set.has(t.buyer)) row.net += t.qty;
    if (set.has(t.seller)) row.net -= t.qty;
  }
  const rows: HistRow[] = shown.map(({ r, s }) => {
    const g = { home: r.home, away: r.away } as ExGame;
    const legs = Object.values(net[r.id] ?? {})
      .filter((x) => Math.abs(x.net) >= 0.5)
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .map((x) => ({ text: sideText(g, x.kind, x.line, x.net), net: Math.abs(x.net), kind: x.kind, line: x.line }));
    return {
      game: r.id, day: r.day, sport: r.sport, kickoff: r.kickoff, teams: `${r.away.abbr} @ ${r.home.abbr}`, score: r.home_score == null ? null : `${r.away_score}-${r.home_score}`,
      staked: s.traded, returned: s.traded + s.pnl, pnl: s.pnl, roi: s.traded > 0 ? s.pnl / s.traded : null, trades: s.n, legs,
    };
  });
  const all = inSport.map((x) => x.s!);
  const staked = all.reduce((a, s) => a + s.traded, 0), pnl = all.reduce((a, s) => a + s.pnl, 0);
  return { rows, sports, total: { games: inSport.length, staked, returned: staked + pnl, pnl } };
}
