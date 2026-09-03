/** Shared spread-convention math, used anywhere a model prediction and a
 * market line need to be shown side by side from one team's perspective.
 *
 * market_spread is already in spread convention (negative = favored by that
 * many points). predicted_margin is a predicted POINT MARGIN (positive =
 * wins by that much) - the OPPOSITE sign convention - so it must be negated
 * before flipping for the picked side, or the two numbers won't actually
 * line up even after picking the right side. Once both are in the same
 * convention and the same perspective, market − model = edge always holds.
 */
export function pickPerspectiveSpread(
  marketSpread: number | null,
  predictedMargin: number | null,
  pickHome: boolean,
): { market: number | null; model: number | null } {
  const market = marketSpread === null ? null : pickHome ? marketSpread : -marketSpread;
  const modelSpread = predictedMargin === null ? null : -predictedMargin;
  const model = modelSpread === null ? null : pickHome ? modelSpread : -modelSpread;
  return { market, model };
}

export function fmtSpread(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}
