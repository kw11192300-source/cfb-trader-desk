import Link from "next/link";
import NhlTeamLogo from "./NhlTeamLogo";
import { marketEdges } from "@/lib/nhlEdges";
import { fmtOdds, pct } from "@/lib/nhlModel";
import type { Game, NhlPrediction } from "@/lib/types";

const nick = (t: string) => t.split(" ").slice(-1)[0];

function Tile({ label, value, sub, tone = "text-foreground" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

/** The day at a glance: how many games, how many starters are confirmed, which games carry a caution, and the best prices
 * against DraftKings right now (baseline model - a place to start looking, not a signal). */
export default function NhlToday({
  label,
  rows,
}: {
  label: string;
  rows: { game: Game; prediction: NhlPrediction | null; cautionCount: number }[];
}) {
  if (rows.length === 0) return null;
  const finals = rows.filter((r) => r.game.completed).length;
  const live = rows.filter((r) => !r.game.completed && r.game.live_status).length;
  const upcoming = rows.length - finals - live;

  const open = rows.filter((r) => !r.game.completed && !r.game.live_status);
  let slots = 0;
  let confirmed = 0;
  for (const r of open) {
    const a = r.prediction?.assumptions;
    if (!a) continue;
    slots += 2;
    confirmed += (a.confirmed?.home ? 1 : 0) + (a.confirmed?.away ? 1 : 0);
  }
  const cautioned = open.filter((r) => r.cautionCount > 0).length;

  const edges = open
    .flatMap((r) =>
      r.prediction && r.prediction.market
        ? marketEdges(r.prediction, r.game.home_team, r.game.away_team).map((e) => ({ e, game: r.game, cautions: r.cautionCount }))
        : [],
    )
    .filter((x) => x.e.ev >= 0.03)
    .sort((a, b) => b.e.ev - a.e.ev);
  const top = edges.slice(0, 5);

  return (
    <section className="mb-4 rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Today · {label}</h2>
        <span className="text-[11px] text-muted">
          {rows.length} games · {upcoming} to play{live > 0 ? ` · ${live} live` : ""}
          {finals > 0 ? ` · ${finals} final` : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Goalies confirmed"
          value={slots > 0 ? `${confirmed} / ${slots}` : "—"}
          sub={slots > 0 ? (confirmed === slots ? "all starters known" : `${slots - confirmed} still expected`) : "no games left"}
          tone={slots > 0 && confirmed === slots ? "text-up" : "text-foreground"}
        />
        <Tile label="Games with a caution" value={`${cautioned}`} sub="⚠ on the card - read before trusting" tone={cautioned > 0 ? "text-warn" : "text-foreground"} />
        <Tile label="Prices ≥ 3% EV" value={`${edges.length}`} sub={`across ${new Set(edges.map((x) => x.game.id)).size} games`} />
        <Tile
          label="Best price"
          value={top[0] ? `+${(top[0].e.ev * 100).toFixed(1)}% EV` : "—"}
          sub={top[0] ? `${top[0].e.market} · ${nick(top[0].game.away_team)} @ ${nick(top[0].game.home_team)}` : "nothing clears 3%"}
          tone={top[0] ? "text-up" : "text-foreground"}
        />
      </div>

      {top.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-3 py-1.5 font-medium">Game</th>
                <th className="px-3 py-1.5 font-medium">Price</th>
                <th className="px-3 py-1.5 text-right font-medium">DK</th>
                <th className="px-3 py-1.5 text-right font-medium">Model</th>
                <th className="px-3 py-1.5 text-right font-medium">Needs</th>
                <th className="px-3 py-1.5 text-right font-medium">EV</th>
              </tr>
            </thead>
            <tbody>
              {top.map(({ e, game, cautions }) => (
                <tr key={`${game.id}-${e.market}-${e.side}`} className="border-b border-border last:border-0 odd:bg-surface/50">
                  <td className="px-3 py-1.5">
                    <Link href={`/nhl/games/${game.id}`} prefetch={false} className="flex items-center gap-1.5 whitespace-nowrap text-foreground hover:underline">
                      <NhlTeamLogo team={game.away_team} size={16} />
                      {nick(game.away_team)}
                      <span className="text-muted">@</span>
                      <NhlTeamLogo team={game.home_team} size={16} />
                      {nick(game.home_team)}
                      {cautions > 0 && <span className="text-warn">⚠</span>}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-foreground">
                    <span className="text-muted">{e.market}</span> {e.side}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-up">{fmtOdds(e.bookOdds)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground">{pct(e.model)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted">{pct(e.bookImplied)}</td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-up">+{(e.ev * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Baseline model: backtested, it does not beat the closing line - so a price here usually means &quot;look at this game&quot;, often because of a lineup or
        goalie fact the model can&apos;t see. Open the game for the reasoning.
      </p>
    </section>
  );
}
