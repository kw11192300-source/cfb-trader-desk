import type { NbaSnapshot } from "./data";
import { type Clv, nhlBetClv } from "./nhlBetClv";
import type { Bet, Game, NhlMarket } from "./types";

/** Closing-line value for an NBA bet: the bet against the last line we logged before tip-off (the latest one while the game has not
 * started). Same arithmetic as the NHL version - the snapshot rows carry the same price fields. Null when no line was logged. */
export function nbaBetClv(bet: Bet, game: Game | null, snaps: NbaSnapshot[] | undefined): Clv | null {
  if (!game || !snaps || snaps.length === 0) return null;
  const start = new Date(game.start_date).getTime();
  const before = snaps.filter((s) => new Date(s.captured_at).getTime() <= start);
  const close = before.length > 0 ? before[before.length - 1] : snaps[snaps.length - 1];
  return nhlBetClv(bet, game, close as unknown as NhlMarket);
}
