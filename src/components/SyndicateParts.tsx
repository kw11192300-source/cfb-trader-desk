import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { type ExGame, type ExSnap, type ExTrade, label, pct, type Row } from "@/lib/syndicates";

const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const tone = (n: number) => (n > 0.005 ? "text-up" : n < -0.005 ? "text-down" : "text-foreground");

export function SyndicateHeader({ active, round }: { active: "board" | "markets"; round?: { n: number; ts: string } | null }) {
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
          <Link href="/today" className="ml-3 text-muted hover:text-foreground">
            ← Trader Desk
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function LeaderTable({ rows, linkBase, title }: { rows: Row[]; linkBase?: string; title: string }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[860px] text-xs">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Equity</th>
              <th className="px-3 py-2 text-right">P&amp;L</th>
              <th className="px-3 py-2 text-right" title="Realized profit divided by units put at risk">ROI/vol</th>
              <th className="px-3 py-2 text-right">Open</th>
              <th className="px-3 py-2 text-right">Trades</th>
              <th className="px-3 py-2 text-right" title="Average of (closing fair price - price paid), in cents per contract, over settled trades">CLV</th>
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
                  {!linkBase && <span className="ml-2 text-muted">{r.syndicate}</span>}
                </td>
                <td className="px-3 py-1.5 text-right">{r.equity.toFixed(1)}</td>
                <td className={`px-3 py-1.5 text-right ${tone(r.pnl)}`}>{u(r.pnl)}</td>
                <td className={`px-3 py-1.5 text-right ${tone(r.roi)}`}>{r.volume > 0 ? `${(r.roi * 100).toFixed(1)}%` : "–"}</td>
                <td className="px-3 py-1.5 text-right text-muted">{r.openRisk.toFixed(1)}</td>
                <td className="px-3 py-1.5 text-right text-muted">{r.trades}</td>
                <td className={`px-3 py-1.5 text-right ${r.clv == null ? "text-muted" : tone(r.clv)}`}>{r.clv == null ? "–" : `${(r.clv * 100).toFixed(1)}¢`}</td>
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
      <h2 className="mb-2 text-sm font-semibold text-foreground">Profit and loss over time (units)</h2>
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
                  <td className="px-3 py-1.5 font-sans text-foreground">{g ? `${g.away.abbr} @ ${g.home.abbr}` : t.game_id}</td>
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
