import Link from "next/link";

import GameSelect from "@/components/GameSelect";
import LocalDateTime from "@/components/LocalDateTime";
import { type ExGame, type ExSnap, type ExTrade, label, pct, type Row } from "@/lib/syndicates";

const u = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const tone = (n: number) => (n > 0.005 ? "text-up" : n < -0.005 ? "text-down" : "text-foreground");

export function SyndicateHeader({ active, round }: { active: "board" | "markets" | "volume" | "history" | "digest" | "crowding" | "positions" | "sports" | "discovery" | "trades" | "closing" | "models" | "reliability" | "signals" | "sharp" | "disagreement" | "news" | "games"; round?: { n: number; ts: string } | null }) {
  const tab = (href: string, text: string, key: string) => (
    <Link href={href} className={`whitespace-nowrap rounded px-3 py-1.5 ${active === key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
      {text}
    </Link>
  );
  // a drop-down that opens on a click and lights up when the page you are on is inside it; opening one closes the others
  const menu = (name: string, items: [string, string, string][]) => (
    <details name="syndicates-menu" className="relative">
      <summary className={`cursor-pointer list-none whitespace-nowrap rounded px-3 py-1.5 ${items.some((x) => x[2] === active) ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{name} <span className="text-[9px]">▾</span></summary>
      <div className="absolute left-0 z-30 mt-1 min-w-[170px] rounded-lg border border-border bg-surface p-1 shadow-lg">
        {items.map(([href, text, key]) => (
          <Link key={key} href={href} className={`block whitespace-nowrap rounded px-3 py-1.5 ${active === key ? "bg-accent text-background" : "text-muted hover:bg-surface-raised hover:text-foreground"}`}>{text}</Link>
        ))}
      </div>
    </details>
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
        <nav className="flex w-full flex-wrap items-center gap-x-1 gap-y-1 text-xs">
          {tab("/syndicates", "Leaderboard", "board")}
          {tab("/syndicates/games", "Games", "games")}
          {menu("Trading", [["/syndicates/markets", "Markets", "markets"], ["/syndicates/positions", "Positions", "positions"], ["/syndicates/trades", "Trades", "trades"], ["/syndicates/volume", "Volume", "volume"], ["/syndicates/crowding", "Crowding", "crowding"]])}
          {menu("Performance", [["/syndicates/history", "Results", "history"], ["/syndicates/digest", "Daily digest", "digest"], ["/syndicates/closing", "Exchange vs DK", "closing"], ["/syndicates/models", "Model scorecard", "models"], ["/syndicates/reliability", "Reliability", "reliability"]])}
          {menu("Research", [["/syndicates/sharp", "Sharp money", "sharp"], ["/syndicates/disagreement", "Disagreement", "disagreement"], ["/syndicates/news", "News", "news"], ["/syndicates/signals", "Signals", "signals"], ["/syndicates/discovery", "Line discovery", "discovery"]])}
          <Link href="/today" className="ml-3 whitespace-nowrap text-muted hover:text-foreground">
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

export function LeaderTable({ rows, linkBase, title, showSyn = false, sort = "clvlow", dir = "desc", sortHref, full = false, fullHref, pageSize, extra }: { rows: Row[]; linkBase?: string; title: string; showSyn?: boolean; sort?: string; dir?: "asc" | "desc"; sortHref?: (key: string, dir: "asc" | "desc") => string; full?: boolean; fullHref?: string; pageSize?: number; extra?: React.ReactNode }) {
  // a header that sorts: click once for the best first, click again to flip
  const th = (k: string, children: React.ReactNode, tip?: string, left = false) => (
    <th key={k} className={`px-3 py-2 ${left ? "text-left" : "text-right"}`} title={tip}>
      {sortHref ? (
        <Link href={sortHref(k, sort === k && dir === "desc" ? "asc" : "desc")} className={`whitespace-nowrap hover:text-foreground ${sort === k ? "text-accent" : ""}`}>
          {children}
          {sort === k ? (dir === "desc" ? " ▼" : " ▲") : ""}
        </Link>
      ) : (
        children
      )}
    </th>
  );
  const sub = "block text-[10px] font-normal text-muted";
  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {fullHref && <Link href={fullHref} scroll={false} className="text-[11px] text-accent hover:underline">{full ? "Fewer columns" : "All columns"}</Link>}
      </div>
      {extra}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className={`w-full text-xs ${full ? "min-w-[1500px]" : "min-w-[960px]"}`}>
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Name</th>
              {th("bank", "Bankroll", "Cash plus the collateral held against open positions: starting units plus profit actually banked. Open positions are not marked in it, so it moves only when games settle or positions are closed out. Below it: how much is free to trade (cash above the reserve a trader never commits) and how much is pending, tied up in open positions", true)}
              {th("spnl", "Settled P&L", "Profit or loss on games that have finished, counting every trade made on them (including positions netted off earlier). Below it: finished games and win rate")}
              {th("open", "Open P&L", "What the open positions would make or lose if closed at the current DraftKings price. It moves with the lines before any game finishes and is not money yet")}
              {th("equity", "Equity", "Bankroll plus open P&L: what the account is worth marked to DraftKings now. Below it: the change over the last 24 hours")}
              {th("clvlow", "CLV", "Closing-line value, ranked by the low end of its 95% range so a big average on a few trades does not win")}
              {th("sroi", "Return on stake", "Settled P&L divided by the units put up on those finished games (a buyer's price, a seller's 1 minus the price, added up across every trade). Below it: that stake")}
              {full && (
                <>
                  {th("cap", "Spread cap.", "How far inside DraftKings' price the quotes were filled, in cents per contract: the spread a market maker earns before anything moves")}
                  {th("vol", "Volume", "Units put at risk by all of this account's trades so far, finished games or not")}
                  {th("trades", "Trades")}
                  {th("risk", "At risk", "Worst-case loss on open positions, across every possible result - not the cash tied up")}
                  <th className="px-3 py-2 text-right">Maker P&amp;L</th>
                  <th className="px-3 py-2 text-right">Taker P&amp;L</th>
                  {th("dd", "Max DD", "Largest drop from the peak")}
                  {th("win", "Win%")}
                  {th("realized", "Realized P&L", "Profit or loss already banked: games that finished and positions that were closed out")}
                </>
              )}
            </tr>
          </thead>
          <tbody className="font-mono">
            {(pageSize ? rows.slice(0, pageSize) : rows).map((r, i) => {
              const share = r.bankroll > 0 ? Math.max(0, Math.min(1, r.available / r.bankroll)) : 0;
              return (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 text-muted">{i + 1}</td>
                  <td className="px-3 py-2 font-sans text-foreground">
                    <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />
                    {linkBase ? (
                      <Link href={`${linkBase}/${r.id}`} className="hover:text-accent">
                        {r.name}
                      </Link>
                    ) : (
                      r.name
                    )}
                    {r.isPublic ? <span className="ml-2 rounded bg-warn/20 px-1.5 py-0.5 text-[10px] font-medium text-warn" title="Public money: recreational flow that pays a few cents over fair. It is in the table for reference and is never treated as sharp">public</span> : r.kind ? <span className="ml-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-normal text-muted">{r.kind}</span> : null}
                    {(!linkBase || showSyn) && <span className="block pl-4 text-[10px] text-muted">{r.syndicate}{r.note ? ` · ${r.note}` : ""}</span>}
                  </td>
                  <td className="min-w-[170px] px-3 py-2 text-left">
                    <span className="text-sm text-foreground">{r.bankroll.toFixed(0)}</span>
                    {share < 0.25 && <span className="ml-2 rounded bg-warn/20 px-1.5 py-0.5 font-sans text-[10px] text-warn" title="Less than a quarter of the bankroll is free to trade">low room</span>}
                    <div className="my-1 flex h-1.5 overflow-hidden rounded bg-border" title={`${r.available.toFixed(0)} free to trade, ${r.pending.toFixed(0)} pending in open positions`}>
                      <i className="block h-full bg-up/70" style={{ width: `${share * 100}%` }} />
                    </div>
                    <span className="font-sans text-[10px] text-muted">{r.available.toFixed(0)} available · {r.pending.toFixed(0)} pending</span>
                  </td>
                  <td className={`px-3 py-2 text-right ${tone(r.sPnl)}`} title={`${r.sGames} finished game${r.sGames === 1 ? "" : "s"}`}>
                    {r.sGames ? u(r.sPnl) : "–"}
                    <span className={sub}>{r.sGames ? `${r.sGames} games${r.winRate != null ? ` · ${(r.winRate * 100).toFixed(0)}% win` : ""}` : "no finished games"}</span>
                  </td>
                  <td className={`px-3 py-2 text-right ${tone(r.open)}`}>{u(r.open)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.equity.toFixed(1)}
                    <span className={`${sub} ${r.chg24 == null ? "" : tone(r.chg24)}`}>{r.chg24 == null ? "" : `${u(r.chg24)} 24h`}</span>
                  </td>
                  <td className={`px-3 py-2 text-right ${clvTone(r)}`} title={r.clvN ? `${r.clvN} settled sides${r.clvSe != null ? `; 95% range ${((r.clv! - 1.96 * r.clvSe) * 100).toFixed(1)}¢ to ${((r.clv! + 1.96 * r.clvSe) * 100).toFixed(1)}¢` : ""}` : undefined}>
                    {r.clv == null ? "–" : `${r.clv >= 0 ? "+" : ""}${(r.clv * 100).toFixed(1)}¢`}
                    {r.clv != null && r.clvSe != null && <span className="ml-1 text-[10px] text-muted">±{(1.96 * r.clvSe * 100).toFixed(1)}</span>}
                    {r.sGames < 10 ? <span className="block text-[10px] font-normal text-warn" title="Fewer than 10 finished games: too early to read as skill">provisional</span> : <span className={sub}>{r.clvN} sides</span>}
                  </td>
                  <td className={`px-3 py-2 text-right ${r.sRoi == null ? "text-muted" : tone(r.sRoi)}`}>
                    {r.sRoi == null ? "–" : `${(r.sRoi * 100).toFixed(1)}%`}
                    <span className={sub}>{r.sGames ? `on ${r.sTraded.toFixed(0)} staked` : ""}</span>
                  </td>
                  {full && (
                    <>
                      <td className={`px-3 py-2 text-right ${r.capture == null ? "text-muted" : tone(r.capture)}`}>{r.capture == null ? "–" : `${r.capture >= 0 ? "+" : ""}${(r.capture * 100).toFixed(2)}¢`}</td>
                      <td className="px-3 py-2 text-right text-muted">{r.volume.toFixed(0)}</td>
                      <td className="px-3 py-2 text-right text-muted">{r.trades}</td>
                      <td className="px-3 py-2 text-right text-muted">{r.openRisk.toFixed(1)}</td>
                      <td className={`px-3 py-2 text-right ${tone(r.makerPnl)}`}>{u(r.makerPnl)}</td>
                      <td className={`px-3 py-2 text-right ${tone(r.takerPnl)}`}>{u(r.takerPnl)}</td>
                      <td className="px-3 py-2 text-right text-muted">{r.maxDd.toFixed(1)}</td>
                      <td className="px-3 py-2 text-right text-muted">{r.winRate == null ? "–" : `${(r.winRate * 100).toFixed(0)}%`}</td>
                      <td className={`px-3 py-2 text-right ${tone(r.realized)}`}>{u(r.realized)}</td>
                    </>
                  )}
                </tr>
              );
            })}
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

export function TradeList({ trades, games, names, title = "Recent trades", moreHref }: { trades: ExTrade[]; games: Record<string, ExGame>; names: Record<string, string>; title?: string; moreHref?: string }) {
  if (!trades.length) return <p className="mb-8 text-xs text-muted">No trades{title === "Recent trades" ? " yet" : " match this filter"}.</p>;
  return (
    <section className="mb-8">
      <h2 className="mb-2 flex items-baseline justify-between text-sm font-semibold text-foreground">
        {title}
        {moreHref && <Link href={moreHref} className="text-[11px] font-normal text-accent hover:underline">Full trade history, with filters →</Link>}
      </h2>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[980px] text-xs">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Sport</th>
              <th className="px-3 py-2">Game</th>
              <th className="px-3 py-2">Game starts</th>
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
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted">
                    <LocalDateTime iso={t.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                  </td>
                  <td className="px-3 py-1.5 font-sans text-muted">{(g?.sport ?? t.game_id.split(":")[0]).toUpperCase()}</td>
                  <td className="px-3 py-1.5 font-sans text-foreground">
                    {g ? (
                      <Link href={`/syndicates/games/${encodeURIComponent(t.game_id)}`} className="hover:text-accent">
                        {g.away.abbr} @ {g.home.abbr}
                      </Link>
                    ) : (
                      t.game_id
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-sans text-muted">
                    {g?.start_utc ? <LocalDateTime iso={g.start_utc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> : "–"}
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
export function HealthStrip({ round, ratings, labs }: { round: { n: number; ts: string; new_trades: number; games: number; secs?: number; errors?: string[]; liq?: { lines: number; two_sided: number; one_sided: number; makers_full: number; makers: number; core?: [number, number] } } | null; ratings: { ts: string } | null; labs: { name: string; error?: string | null; version?: number }[] }) {
  const r = ago(round?.ts), f = ago(ratings?.ts);
  const roundTone = r.mins < 25 ? "bg-up" : r.mins < 60 ? "bg-warn" : "bg-down";
  const ratingsTone = f.mins < 9 * 60 ? "bg-up" : f.mins < 24 * 60 ? "bg-warn" : "bg-down";
  const broken = labs.filter((l) => l.error);
  const liq = round?.liq;
  const core = liq?.core && liq.core[1] ? liq.core[0] / liq.core[1] : null; // the moneyline and main spread and total of every game: the lines that must always have a market
  const share = core ?? (liq && liq.lines ? liq.two_sided / liq.lines : null);
  const liqTone = share == null ? "bg-warn" : share < 0.2 ? "bg-down" : share < 0.5 ? "bg-warn" : "bg-up";
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-muted">
      {liq && share != null && share < 0.2 && (
        <span className="w-full rounded bg-down/15 px-2 py-1 text-down">Thin book: only {(share * 100).toFixed(0)}% of {liq.core ? "main lines" : "lines"} have a bid and an ask.</span>
      )}
      <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${roundTone}`} /> Last round <span className="text-foreground">{round ? `#${round.n}, ${r.text}` : "none yet"}</span>{round?.secs ? ` (${round.secs.toFixed(0)} s)` : ""}</span>
      {round && <span>{round.games} games listed · {round.new_trades} new trades that round</span>}
      {liq && (
        <span className="flex items-center gap-1.5" title="Main lines are every game's moneyline and the spread and total nearest the main number: they are always quoted. All lines include the wings of each ladder, which are quoted as a game gets closer. Makers past soft cap have used 70% of their risk budget and quote only main lines until positions settle.">
          <span className={`h-2 w-2 rounded-full ${liqTone}`} /> Main lines two-sided {liq.core ? <span className="text-foreground">{liq.core[0].toLocaleString()} of {liq.core[1].toLocaleString()}</span> : null}
          {" "}· all lines <span className="text-foreground">{liq.two_sided.toLocaleString()} of {liq.lines.toLocaleString()}</span>
          {" "}· makers past soft cap <span className="text-foreground">{liq.makers_full}/{liq.makers}</span>
        </span>
      )}
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

const FILTER_SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"];

/** Narrow a syndicate or trader page to one sport, or to one game, from a list of the games it has traded. Plain links and a plain form, so it works without scripts. */
export function TradeFilters({ base, sport, game, games, contracts = [], contract = null }: { base: string; sport: string | null; game: string | null; games: ExGame[]; contracts?: { key: string; label: string }[]; contract?: string | null }) {
  const opts = [...games].sort((a, b) => a.sport.localeCompare(b.sport) || a.start_utc.localeCompare(b.start_utc)).filter((g) => !sport || g.sport === sport);
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  const picked = game ? games.find((g) => g.id === game) : null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2 text-[11px]">
      <span className="text-muted">Filter</span>
      <div className="flex flex-wrap gap-1">
        <Link href={base} className={chip(!sport && !game)}>All sports</Link>
        {FILTER_SPORTS.map((s) => <Link key={s} href={`${base}?sport=${s}`} className={chip(sport === s && !game)}>{s.toUpperCase()}</Link>)}
      </div>
      <form method="get" action={base} className="flex items-center gap-2">
        {sport && !game ? <input type="hidden" name="sport" value={sport} /> : null}
        <GameSelect name="game" value={game ?? ""} anyLabel={`Any game traded${sport ? ` (${sport.toUpperCase()})` : ""}`} games={opts.map((g) => ({ id: g.id, sport: g.sport, away: g.away.abbr, home: g.home.abbr, start: g.start_utc }))} />
        {game && contracts.length > 0 && (
          <select name="c" defaultValue={contract ?? ""} title="Only trades on this selection" className="max-w-[200px] rounded border border-border bg-background px-2 py-1 text-foreground">
            <option value="">Every selection</option>
            {contracts.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        )}
        <button type="submit" className="rounded bg-accent px-2.5 py-1 font-medium text-background">Show</button>
      </form>
      {(sport || game) && <Link href={base} className="text-muted hover:text-foreground">Clear</Link>}
      {contract && <span className="text-foreground">Only trades on the selected line</span>}
      {picked && <span className="text-foreground">{picked.away.name} at {picked.home.name}</span>}
    </div>
  );
}
