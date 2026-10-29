import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { type ExGame, type ExSnap, type ExTrade, label, pct, type Row } from "@/lib/syndicates";

const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const tone = (n: number) => (n > 0.005 ? "text-up" : n < -0.005 ? "text-down" : "text-foreground");

export function SyndicateHeader({ active, round }: { active: "board" | "markets" | "volume" | "history" | "digest" | "crowding" | "positions" | "sports"; round?: { n: number; ts: string } | null }) {
  const tab = (href: string, text: string, key: string) => (
    <Link href={href} className={`rounded px-3 py-1.5 ${active === key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
      {text}
    </Link>
  );
  return (
    <header className="border-b border-border bg-surface px-6 py-4">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/syndicates">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Syndicates <span className="text-accent">Exchange</span>
            </h1>
          </Link>
          <p className="text-xs text-muted">
            Paper money only · agents trade against each other around the DraftKings price
            {round ? (
              <>
                {" "}
                · round {round.n}, <LocalDateTime iso={round.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
              </>
            ) : null}
          </p>
        </div>
        <nav className="flex items-center gap-1 text-xs">
          {tab("/syndicates", "Leaderboard", "board")}
          {tab("/syndicates/markets", "Markets", "markets")}
          {tab("/syndicates/positions", "Positions", "positions")}
          {tab("/syndicates/volume", "Volume", "volume")}
          {tab("/syndicates/history", "Results", "history")}
          {tab("/syndicates/digest", "Digest", "digest")}
          {tab("/syndicates/crowding", "Crowding", "crowding")}
          <Link href="/today" className="ml-3 text-muted hover:text-foreground">
            ← Trader Desk
          </Link>
        </nav>
      </div>
    </header>
  );
}

/** Green or red only when the whole 95% range sits on one side of zero; grey while the sample is too small to tell. */
function clvTone(r: Row): string {
  if (r.clv == null) return "text-muted";
  if (r.clvSe == null) return "text-muted";
  const lo = r.clv - 1.96 * r.clvSe, hi = r.clv + 1.96 * r.clvSe;
  return lo > 0 ? "text-up" : hi < 0 ? "text-down" : "text-muted";
}

export function LeaderTable({ rows, linkBase, title, showSyn = false }: { rows: Row[]; linkBase?: string; title: string; showSyn?: boolean }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[1060px] text-xs">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right" title="Starting units plus profit actually banked (finished games and trades netted off). Cash and collateral; open positions count at what they cost">Bankroll</th>
              <th className="px-3 py-2 text-right" title="Profit or loss already banked: games that finished and positions that were closed out">Realized P&amp;L</th>
              <th className="px-3 py-2 text-right" title="What the open positions would make or lose if closed at the current DraftKings price. It moves with the lines before any game finishes and is not money yet">Open P&amp;L</th>
              <th className="px-3 py-2 text-right" title="Bankroll plus open P&L: what the account is worth marked to DraftKings now">Equity</th>
              <th className="px-3 py-2 text-right" title="Realized profit divided by units put at risk">ROI/vol</th>
              <th className="px-3 py-2 text-right" title="Worst-case loss on open positions, across every possible result - not the cash tied up">At risk</th>
              <th className="px-3 py-2 text-right">Trades</th>
              <th className="px-3 py-2 text-right" title="Average of (closing fair price - price paid), in cents per contract, over settled trades">CLV</th>
              <th className="px-3 py-2 text-right" title="How far inside DraftKings' price the quotes were filled, in cents per contract: the spread a market maker earns before anything moves">Spread cap.</th>
              <th className="px-3 py-2 text-right">Maker P&amp;L</th>
              <th className="px-3 py-2 text-right">Taker P&amp;L</th>
              <th className="px-3 py-2 text-right" title="Largest drop from the peak">Max DD</th>
              <th className="px-3 py-2 text-right">Win%</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                <td className="px-3 py-1.5 font-sans text-foreground">
                  <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />
                  {linkBase ? (
                    <Link href={`${linkBase}/${r.id}`} className="hover:text-accent">
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                  {(!linkBase || showSyn) && <span className="ml-2 text-muted">{r.syndicate}{r.note ? ` · ${r.note}` : ""}</span>}
                </td>
                <td className="px-3 py-1.5 text-right">{r.bankroll.toFixed(1)}</td>
                <td className={`px-3 py-1.5 text-right ${tone(r.realized)}`}>{u(r.realized)}</td>
                <td className={`px-3 py-1.5 text-right ${tone(r.open)}`}>{u(r.open)}</td>
                <td className="px-3 py-1.5 text-right">{r.equity.toFixed(1)}</td>
                <td className={`px-3 py-1.5 text-right ${tone(r.roi)}`}>{r.volume > 0 ? `${(r.roi * 100).toFixed(1)}%` : "–"}</td>
                <td className="px-3 py-1.5 text-right text-muted">{r.openRisk.toFixed(1)}</td>
                <td className="px-3 py-1.5 text-right text-muted">{r.trades}</td>
                <td className={`px-3 py-1.5 text-right ${clvTone(r)}`} title={r.clvN ? `${r.clvN} settled sides${r.clvSe != null ? `; 95% range ${((r.clv! - 1.96 * r.clvSe) * 100).toFixed(1)}¢ to ${((r.clv! + 1.96 * r.clvSe) * 100).toFixed(1)}¢` : ""}` : undefined}>
                  {r.clv == null ? "–" : `${r.clv >= 0 ? "+" : ""}${(r.clv * 100).toFixed(1)}¢`}
                  {r.clv != null && r.clvSe != null && <span className="ml-1 text-[10px] text-muted">±{(1.96 * r.clvSe * 100).toFixed(1)}</span>}
                </td>
                <td className={`px-3 py-1.5 text-right ${r.capture == null ? "text-muted" : tone(r.capture)}`}>{r.capture == null ? "–" : `${r.capture >= 0 ? "+" : ""}${(r.capture * 100).toFixed(2)}¢`}</td>
                <td className={`px-3 py-1.5 text-right ${tone(r.makerPnl)}`}>{u(r.makerPnl)}</td>
                <td className={`px-3 py-1.5 text-right ${tone(r.takerPnl)}`}>{u(r.takerPnl)}</td>
                <td className="px-3 py-1.5 text-right text-muted">{r.maxDd.toFixed(1)}</td>
                <td className="px-3 py-1.5 text-right text-muted">{r.winRate == null ? "–" : `${(r.winRate * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Equity over time, one line per subject, drawn relative to where each started (profit and loss in units). */
export function EquityChart({ snaps, colors, names, start }: { snaps: ExSnap[]; colors: Record<string, string>; names: Record<string, string>; start: Record<string, number> }) {
  if (snaps.length < 4) return <p className="mb-8 text-xs text-muted">The equity chart fills in after the first few rounds.</p>;
  const by: Record<string, { t: number; v: number }[]> = {};
  for (const s of snaps) {
    const id = s.subject.split(":")[1];
    (by[id] ??= []).push({ t: new Date(s.ts).getTime(), v: s.equity - (start[id] ?? 0) });
  }
  const all = Object.values(by).flat();
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const lo = Math.min(0, ...all.map((p) => p.v));
  const hi = Math.max(0, ...all.map((p) => p.v));
  const W = 900, H = 240, L = 44, R = 12, T = 10, B = 20;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1e-6, hi - lo)) * (H - T - B);
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-semibold text-foreground">Equity change over time (bankroll plus open P&amp;L, in units)</h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-border bg-surface">
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-border" strokeDasharray="3 3" />
        {[lo, hi].map((v) => (
          <text key={v} x={L - 6} y={y(v) + 3} textAnchor="end" className="fill-muted" fontSize="10">
            {v.toFixed(0)}
          </text>
        ))}
        {Object.entries(by).map(([id, pts]) => (
          <polyline key={id} fill="none" stroke={colors[id] ?? "#888"} strokeWidth="1.6" points={pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}>
            <title>{names[id] ?? id}</title>
          </polyline>
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {Object.keys(by).map((id) => (
          <span key={id}>
            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: colors[id] ?? "#888" }} />
            {names[id] ?? id}
          </span>
        ))}
      </div>
    </section>
  );
}

export function TradeList({ trades, games, names }: { trades: ExTrade[]; games: Record<string, ExGame>; names: Record<string, string> }) {
  if (!trades.length) return <p className="mb-8 text-xs text-muted">No trades yet.</p>;
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-semibold text-foreground">Recent trades</h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[820px] text-xs">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Game</th>
              <th className="px-3 py-2">Contract</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Fair</th>
              <th className="px-3 py-2 text-right">Size</th>
              <th className="px-3 py-2">Buyer</th>
              <th className="px-3 py-2">Seller</th>
              <th className="px-3 py-2 text-right">Result</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {trades.map((t) => {
              const g = games[t.game_id];
              const res = t.outcome == null ? "open" : t.outcome === 0.5 ? "push" : t.outcome === 1 ? "yes" : "no";
              return (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-3 py-1.5 text-muted">
                    <LocalDateTime iso={t.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                  </td>
                  <td className="px-3 py-1.5 font-sans text-foreground">
                    {g ? (
                      <Link href={`/syndicates/games/${encodeURIComponent(t.game_id)}`} className="hover:text-accent">
                        {g.away.abbr} @ {g.home.abbr}
                      </Link>
                    ) : (
                      t.game_id
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-sans">{label(t, g)}</td>
                  <td className="px-3 py-1.5 text-right">{pct(t.price)}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{pct(t.ref_p)}</td>
                  <td className="px-3 py-1.5 text-right">{t.qty}</td>
                  <td className={`px-3 py-1.5 font-sans ${t.maker === t.buyer ? "text-muted" : "text-foreground"}`}>{names[t.buyer] ?? t.buyer}</td>
                  <td className={`px-3 py-1.5 font-sans ${t.maker === t.seller ? "text-muted" : "text-foreground"}`}>{names[t.seller] ?? t.seller}</td>
                  <td className={`px-3 py-1.5 text-right ${res === "open" ? "text-accent" : "text-muted"}`}>{res}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted">Greyed names posted the quote (the maker); the other side took it. Price and fair are the cost of a yes contract that pays 100¢.</p>
    </section>
  );
}

/** The four money columns in plain words, shown once under a leaderboard. */
export function MoneyLegend() {
  return (
    <p className="-mt-5 mb-8 max-w-4xl text-[11px] leading-relaxed text-muted">
      <span className="text-foreground">Bankroll</span> is starting units plus profit actually banked, from finished games and positions closed out. It is the cash and collateral in the account.{" "}
      <span className="text-foreground">Realized P&amp;L</span> is that banked profit on its own.{" "}
      <span className="text-foreground">Open P&amp;L</span> is what the open positions would make or lose if closed at DraftKings&rsquo; price right now: it moves with the lines and is not money yet.{" "}
      <span className="text-foreground">Equity</span> is bankroll plus open P&amp;L.
    </p>
  );
}

const ago = (iso: string | undefined | null): { text: string; mins: number } => {
  if (!iso) return { text: "never", mins: Infinity };
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  return { text: mins < 1 ? "just now" : mins < 90 ? `${Math.round(mins)} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`, mins };
};

/** Is the exchange running? Last round and its health, the last ratings fit, and any lab whose model is failing. */
export function HealthStrip({ round, ratings, labs }: { round: { n: number; ts: string; new_trades: number; games: number; secs?: number; errors?: string[] } | null; ratings: { ts: string } | null; labs: { name: string; error?: string | null; version?: number }[] }) {
  const r = ago(round?.ts), f = ago(ratings?.ts);
  const roundTone = r.mins < 25 ? "bg-up" : r.mins < 60 ? "bg-warn" : "bg-down";
  const ratingsTone = f.mins < 9 * 60 ? "bg-up" : f.mins < 24 * 60 ? "bg-warn" : "bg-down";
  const broken = labs.filter((l) => l.error);
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-muted">
      <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${roundTone}`} /> Last round <span className="text-foreground">{round ? `#${round.n}, ${r.text}` : "none yet"}</span>{round?.secs ? ` (${round.secs.toFixed(0)} s)` : ""}</span>
      {round && <span>{round.games} games listed · {round.new_trades} new trades that round</span>}
      <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${ratingsTone}`} /> Ratings fitted <span className="text-foreground">{f.text}</span></span>
      {labs.length > 0 && (
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${broken.length ? "bg-down" : "bg-up"}`} />
          Labs {broken.length ? <span className="text-down">{broken.map((b) => b.name).join(", ")} failing</span> : <span className="text-foreground">all models running</span>}
        </span>
      )}
    </div>
  );
}
