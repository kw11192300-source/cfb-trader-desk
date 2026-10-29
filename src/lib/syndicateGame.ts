import type { ExGame, ExTrade, Lot } from "./syndicates";

const SD: Record<string, { m: number; t: number }> = { nfl: { m: 13.2, t: 13.5 }, cfb: { m: 14, t: 17 }, nba: { m: 12.9, t: 18 }, cbb: { m: 11.3, t: 16.8 }, nhl: { m: 2.3, t: 2.4 } };

/** 1 if the 'yes' side of a contract wins at this final margin (home minus away) and total, 0.5 on a push. */
export function yesAt(kind: string, line: number, margin: number, total: number): number {
  const v = kind === "ml" ? margin : kind === "spread" ? margin + line : total - line;
  return v > 0 ? 1 : v < 0 ? 0 : 0.5;
}

export function lotPnl(l: Lot, margin: number, total: number): number {
  const y = yesAt(l.kind, l.line, margin, total);
  return l.qty > 0 ? l.qty * (y - l.price) : -l.qty * (l.price - y);
}

export type Scenario = { id: string; label: string; margin: number; total: number; dim: "m" | "t" };

/** A handful of concrete final scores to read exposure against: a big win, a close win, a close loss, a big loss, and totals well over, on, and well under the line. */
export function scenarios(g: ExGame): Scenario[] {
  const sd = SD[g.sport] ?? SD.nba;
  const big = g.sport === "nhl" ? 3 : Math.round(sd.m);
  const close = g.sport === "nhl" ? 1 : Math.max(1, Math.round(sd.m * 0.4));
  const tdev = g.sport === "nhl" ? 2 : Math.round(sd.t * 0.8);
  const main = g.ref?.total ?? (g.sport === "nhl" ? 6 : 140);
  const base = Math.round(main);
  const h = g.home.abbr, a = g.away.abbr;
  return [
    { id: "hb", label: `${h} wins by ${big}`, margin: big, total: base, dim: "m" },
    { id: "hc", label: `${h} wins by ${close}`, margin: close, total: base, dim: "m" },
    { id: "ac", label: `${a} wins by ${close}`, margin: -close, total: base, dim: "m" },
    { id: "ab", label: `${a} wins by ${big}`, margin: -big, total: base, dim: "m" },
    { id: "ov", label: `Total ${base + tdev}`, margin: 0, total: base + tdev, dim: "t" },
    { id: "mid", label: `Total ${base}`, margin: 0, total: base, dim: "t" },
    { id: "un", label: `Total ${base - tdev}`, margin: 0, total: base - tdev, dim: "t" },
  ];
}

export function scenarioPnl(lots: Lot[], s: Scenario): number {
  return lots.filter((l) => (s.dim === "t") === (l.kind === "total")).reduce((a, l) => a + lotPnl(l, s.margin, s.total), 0);
}

/** What a position pays if its contract resolves yes, and if it resolves no. */
export function yesNo(lots: Lot[]): { yes: number; no: number } {
  let yes = 0, no = 0;
  for (const l of lots) {
    if (l.qty > 0) { yes += l.qty * (1 - l.price); no -= l.qty * l.price; }
    else { yes -= -l.qty * (1 - l.price); no += -l.qty * l.price; }
  }
  return { yes, no };
}

export const takerOf = (t: Pick<ExTrade, "buyer" | "seller" | "maker">): string => (t.maker === t.seller ? t.buyer : t.seller);
