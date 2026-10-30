import { lotPnl } from "./syndicateGame";
import type { ExGame, Lot } from "./syndicates";

const SD: Record<string, { m: number; t: number }> = { nfl: { m: 13.2, t: 13.5 }, cfb: { m: 14, t: 17 }, nba: { m: 12.9, t: 18 }, cbb: { m: 11.3, t: 16.8 }, nhl: { m: 2.3, t: 2.4 } };

function cdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export type Band = { lo: number | null; hi: number | null; label: string; pnl: number; chance: number | null };
export type Leg = { kind: Lot["kind"]; line: number; net: number; avg: number | null; text: string; paid: number | null; holders: Record<string, number>; long: number; short: number };
export type GameCard = {
  gid: string; g: ExGame; legs: Leg[]; contracts: number; units: number; margin: Band[]; total: Band[]; worst: number; best: number; mtm: number;
};

/** Plain words for the side a position backs: "AKR +7.5", "OHIO -7.5", "Over 51.5". */
export function sideText(g: ExGame, kind: string, line: number, net: number): string {
  const h = g.home.abbr, a = g.away.abbr;
  const sg = (n: number) => `${n > 0 ? "+" : ""}${n}`;
  if (kind === "ml") return `${net >= 0 ? h : a} to win`;
  if (kind === "spread") return net >= 0 ? `${h} ${sg(line)}` : `${a} ${sg(-line)}`;
  return `${net >= 0 ? "Over" : "Under"} ${line}`;
}

/** Where a contract flips from losing to winning, as the integer after which the result changes. */
function boundaries(kind: string, line: number): number[] {
  const whole = Number.isInteger(line);
  if (kind === "total") return whole ? [line - 1, line] : [Math.floor(line)];
  return whole ? [-line - 1, -line] : [Math.floor(-line)];
}

function bandsFor(lots: Lot[], g: ExGame, dim: "m" | "t"): Band[] {
  const ls = lots.filter((l) => (dim === "t") === (l.kind === "total"));
  if (!ls.length) return [];
  const cuts = [...new Set(ls.flatMap((l) => boundaries(l.kind, l.line)))].sort((a, b) => a - b);
  const sd = SD[g.sport] ?? SD.nba;
  const mu = dim === "m" ? (g.ref?.spread != null ? -g.ref.spread : null) : g.ref?.total ?? null;
  const sigma = dim === "m" ? sd.m : sd.t;
  const h = g.home.abbr, a = g.away.abbr;
  const out: Band[] = [];
  for (let i = 0; i <= cuts.length; i++) {
    const lo = i === 0 ? null : cuts[i - 1] + 1;
    const hi = i === cuts.length ? null : cuts[i];
    const rep = lo ?? hi!;
    const pnl = ls.reduce((s, l) => s + lotPnl(l, dim === "m" ? rep : 0, dim === "t" ? rep : 0), 0);
    const chance = mu == null ? null : (hi == null ? 1 : cdf((hi + 0.5 - mu) / sigma)) - (lo == null ? 0 : cdf((lo - 0.5 - mu) / sigma));
    let label: string;
    if (dim === "t") {
      label = lo == null ? `${hi} or fewer points` : hi == null ? `${lo} or more points` : lo === hi ? `Exactly ${lo} points` : `${lo} to ${hi} points`;
    } else if (lo == null) {
      label = hi! >= 1 ? `${a} wins, or ${h} by ${hi === 1 ? "1" : `1 to ${hi}`}` : hi === 0 ? `${a} wins` : `${a} wins by ${-hi!} or more`;
    } else if (hi == null) {
      label = lo >= 2 ? `${h} wins by ${lo} or more` : lo === 1 ? `${h} wins` : lo === 0 ? `${h} wins or ties` : `${h} wins, or ${a} by ${-lo} or fewer`;
    } else if (lo >= 1) {
      label = lo === hi ? `${h} wins by ${lo}` : `${h} wins by ${lo} to ${hi}`;
    } else if (hi <= -1) {
      label = lo === hi ? `${a} wins by ${-hi}` : `${a} wins by ${-hi} to ${-lo}`;
    } else {
      label = `Close: ${a} by ${Math.max(0, -lo)} to ${h} by ${Math.max(0, hi)}`;
    }
    out.push({ lo, hi, label, pnl, chance });
  }
  return out.reverse(); // home blowouts and high totals at the top
}

/** One card of numbers per game from a set of open lots (a syndicate's, a trader's, or anyone's). */
export function gameCards(lots: Lot[], games: Record<string, ExGame>, fair: (g: ExGame, kind: string, line: number) => number | null): GameCard[] {
  const byGame: Record<string, Lot[]> = {};
  for (const l of lots) (byGame[l.gid] ??= []).push(l);
  const cards: GameCard[] = [];
  for (const [gid, ls] of Object.entries(byGame)) {
    const g = games[gid];
    if (!g) continue;
    const legsMap: Record<string, Leg> = {};
    for (const l of ls) {
      const L = (legsMap[`${l.kind}|${l.line}`] ??= { kind: l.kind, line: l.line, net: 0, avg: null, text: "", paid: null, holders: {}, long: 0, short: 0 });
      L.holders[l.holder] = (L.holders[l.holder] ?? 0) + l.qty;
    }
    const legs = Object.values(legsMap).map((L) => {
      const mine = ls.filter((l) => l.kind === L.kind && l.line === L.line);
      const long = mine.filter((l) => l.qty > 0), short = mine.filter((l) => l.qty < 0);
      const lq = long.reduce((s, l) => s + l.qty, 0), sq = short.reduce((s, l) => s - l.qty, 0);
      const net = lq - sq;
      const avgLong = lq ? long.reduce((s, l) => s + l.qty * l.price, 0) / lq : null;
      const avgShort = sq ? short.reduce((s, l) => s - l.qty * l.price, 0) / sq : null;
      const price = net >= 0 ? avgLong : avgShort;
      return { ...L, net, long: lq, short: sq, avg: price, paid: price == null ? null : net >= 0 ? price : 1 - price, text: sideText(g, L.kind, L.line, net) };
    }).filter((L) => Math.abs(L.net) > 0.05 || L.long > 0.05).sort((x, y) => x.kind.localeCompare(y.kind) || x.line - y.line);
    const margin = bandsFor(ls, g, "m"), total = bandsFor(ls, g, "t");
    const worst = Math.min(0, ...margin.map((b) => b.pnl)) + Math.min(0, ...total.map((b) => b.pnl));
    const best = Math.max(0, ...margin.map((b) => b.pnl)) + Math.max(0, ...total.map((b) => b.pnl));
    const mtm = ls.reduce((s, l) => {
      const f = fair(g, l.kind, l.line);
      return f == null ? s : s + (l.qty > 0 ? l.qty * (f - l.price) : -l.qty * (l.price - f));
    }, 0);
    cards.push({ gid, g, legs, contracts: ls.reduce((s, l) => s + Math.abs(l.qty), 0), units: ls.reduce((s, l) => s + Math.abs(l.qty) * (l.qty > 0 ? l.price : 1 - l.price), 0), margin, total, worst, best, mtm });
  }
  return cards.sort((a, b) => a.g.start_utc.localeCompare(b.g.start_utc));
}
