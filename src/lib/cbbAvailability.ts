import type { CbbAvailability, CbbBoardRow } from "./types";

// What a missing player is worth, fitted on 2023-25 games (17k): for each rotation player who sat, the margin moved by
//     MARGIN_RATING * (f * v) + MARGIN_MINUTES * f        points against our model's number (f = share of the game, v = rating)
// and the total by TOTAL_MINUTES * f. The market had priced only part of it at the open (about a quarter) and at the close
// (about half), which is why a known absence is worth acting on.
export const MARGIN_RATING = 0.41;
export const MARGIN_MINUTES = 1.16;
export const TOTAL_MINUTES = -0.6;
const MARGIN_SD = 11.3;
const TOTAL_SD = 16.8;

/** Chance the player misses the game for each status. */
export const STATUS_P: Record<string, number> = { out: 1, doubtful: 0.75, questionable: 0.5, probable: 0.15 };

function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export type AvailEffect = { id: number; name: string; status: string; margin: number; total: number };

/** The points a single missing player costs his own team (margin = how much worse) and the change in the total. */
export function playerEffect(a: Pick<CbbAvailability, "f" | "v" | "status">): { margin: number; total: number } {
  const p = STATUS_P[a.status] ?? 1;
  return { margin: p * (MARGIN_RATING * a.f * a.v + MARGIN_MINUTES * a.f), total: p * TOTAL_MINUTES * a.f };
}

export type Adjusted = {
  spread: number | null; // adjusted home margin
  total: number | null;
  homeWin: number | null;
  pCoverHome: number | null;
  pOver: number | null;
  dMargin: number; // change vs the base model, home perspective
  dTotal: number;
  home: AvailEffect[];
  away: AvailEffect[];
};

/** Applies the availability rows for the two teams to one board row. */
export function adjustRow(row: CbbBoardRow, avail: CbbAvailability[]): Adjusted {
  const m = row.payload.model;
  const mk = row.payload.market;
  const mine = (teamId: number | null): AvailEffect[] =>
    avail
      .filter((a) => teamId !== null && a.team_id === teamId)
      .map((a) => {
        const e = playerEffect(a);
        return { id: a.id, name: a.player_name, status: a.status, margin: e.margin, total: e.total };
      });
  const home = mine(row.home_team_id);
  const away = mine(row.away_team_id);
  const dMargin = -home.reduce((s, e) => s + e.margin, 0) + away.reduce((s, e) => s + e.margin, 0);
  const dTotal = [...home, ...away].reduce((s, e) => s + e.total, 0);
  const spread = m.spread === null ? null : m.spread + dMargin;
  const total = m.total === null ? null : m.total + dTotal;
  return {
    spread,
    total,
    homeWin: spread === null ? null : phi(spread / MARGIN_SD),
    pCoverHome: spread === null || mk.cur_margin === null ? null : phi((spread - mk.cur_margin) / MARGIN_SD),
    pOver: total === null || mk.cur_total === null ? null : phi((total - mk.cur_total) / TOTAL_SD),
    dMargin,
    dTotal,
    home,
    away,
  };
}
