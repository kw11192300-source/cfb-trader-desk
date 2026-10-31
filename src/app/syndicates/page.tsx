import Link from "next/link";

import { ago, EquityChart, HealthStrip, LeaderTable, MoneyLegend, SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import { getEquityDayAgo, getExchange, getExchangeGamesByIds, getExchangeSnapshots, getExchangeTrades, type Row, SORTS, sortRows, summarize } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const sgn = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

/** A short list of accounts for a glance: who is leading on something, or who needs a look. A card can hold more than one list. */
function Spotlight({ title, note, lists }: { title: string; note: string; lists: { label?: string; rows: Row[]; line: (r: Row) => React.ReactNode }[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-xs font-semibold text-foreground">{title}</p>
      <p className="mb-2 text-[10px] text-muted">{note}</p>
      {lists.map((l, i) => (
        <div key={i} className={i ? "mt-3" : ""}>
          {l.label && <p className="text-[10px] uppercase tracking-wide text-muted">{l.label}</p>}
          {l.rows.length === 0 ? <p className="border-t border-border py-1.5 text-[11px] text-muted">Nobody yet.</p> : l.rows.map((r) => (
            <Link key={r.id} href={`/syndicates/traders/${r.id}`} className="flex items-center justify-between gap-2 border-t border-border py-1.5 text-[11px] hover:text-accent">
              <span className="min-w-0 truncate"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />{r.name}<span className="ml-1.5 text-[10px] text-muted">{r.syndicate}</span></span>
              <span className="shrink-0 font-mono">{l.line(r)}</span>
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

export default async function SyndicatesPage({ searchParams }: { searchParams: Promise<{ sort?: string; dir?: string; cols?: string; syn?: string; all?: string }> }) {
  const q = await searchParams;
  const sort = SORTS.some((s) => s.key === q.sort) ? q.sort! : "clvlow";
  const dir = q.dir === "asc" ? "asc" : "desc";
  const full = q.cols === "all";
  const href = (o: { sort?: string; dir?: string; cols?: string | null; syn?: string | null; all?: string | null }) => {
    const p = new URLSearchParams();
    const v = { sort: o.sort ?? sort, dir: o.dir ?? dir, cols: o.cols === undefined ? q.cols : o.cols, syn: o.syn === undefined ? q.syn : o.syn, all: o.all === undefined ? q.all : o.all };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    return `/syndicates?${p}`;
  };
  const sortHref = (k: string, d: "asc" | "desc") => href({ sort: k, dir: d });
  const { syndicates, members, meta, ratingsMeta, configured } = await getExchange();
  if (!configured || !syndicates.length) {
    return (
      <div className="min-h-screen">
        <SyndicateHeader active="board" />
        <main className="mx-auto max-w-3xl px-6 py-10 text-sm text-muted">
          <p className="mb-2 text-foreground">The exchange has not started yet.</p>
          <p>Run the ex_ table block from supabase/schema.sql, then start the &ldquo;Exchange round&rdquo; workflow from the Actions tab.</p>
        </main>
      </div>
    );
  }
  const [snaps, trades, agoS, agoM] = await Promise.all([getExchangeSnapshots("syn:"), getExchangeTrades({ limit: 40 }), getEquityDayAgo("syn:"), getEquityDayAgo("mem:")]);
  const games = await getExchangeGamesByIds([...new Set(trades.map((t) => t.game_id))]);
  const { members: mrows0, syndicates: srows0 } = summarize(syndicates, members);
  const withChg = (rows: Row[], ago: Record<string, number>): Row[] => rows.map((r) => ({ ...r, chg24: ago[r.id] != null ? r.equity - ago[r.id] : null }));
  const mrows = withChg(mrows0, agoM), srows = withChg(srows0, agoS);
  const synFilter = syndicates.find((s) => s.name === q.syn)?.name ?? null;
  const tradersIn = synFilter ? mrows.filter((r) => r.syndicate === synFilter) : mrows;
  const srowsS = sortRows(srows, sort, dir);
  const mrowsS = sortRows(tradersIn, sort, dir);
  const real = mrows.filter((r) => !r.isPublic);
  const bestClv = sortRows(real.filter((r) => r.clvN > 0 && r.sGames >= 10), "clvlow").slice(0, 5);
  const bestPnl = sortRows(real.filter((r) => r.sGames > 0), "spnl").slice(0, 5);
  const moved = real.filter((r) => r.chg24 != null);
  const up = [...moved].sort((a, b) => b.chg24! - a.chg24!).slice(0, 3);
  const down = [...moved].sort((a, b) => a.chg24! - b.chg24!).slice(0, 3);
  const traded = real.filter((r) => r.lastTrade);
  const recent = [...traded].sort((a, b) => b.lastTrade!.localeCompare(a.lastTrade!)).slice(0, 3);
  const quiet = [...traded].sort((a, b) => a.lastTrade!.localeCompare(b.lastTrade!)).slice(0, 3);
  const capture = sortRows(real.filter((r) => r.capture != null), "cap").slice(0, 5);
  const drawdown = sortRows(real.filter((r) => r.maxDd > 0), "dd").slice(0, 5);
  const names = Object.fromEntries(members.map((m) => [m.id, `${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""} · ${m.name}`]));
  const colors = Object.fromEntries(syndicates.map((s) => [s.id, s.color]));
  const sNames = Object.fromEntries(syndicates.map((s) => [s.id, s.name]));
  const start = Object.fromEntries(syndicates.map((s) => [s.id, s.start_units]));
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="board" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-6 max-w-3xl text-xs leading-relaxed text-muted">
          Sixteen firms trade here. Fifteen are trading firms, each with its own approach, starting with 10,000 units across five sport desks (NFL, CFB, NHL, NBA, CBB). The sixteenth, Main Street, is public money: eight recreational bettors with 25,000 units who lean to favorites, overs and underdog moneylines, bet mostly in the last few hours before a game, and pay a few cents over fair. They are in the table for reference and are not sharp; the market makers earn their living from flow like theirs. A contract pays 1 unit
          if its side wins: the buyer posts the price, the seller posts the rest, so nobody can lose more than they put up. Every trader shares one goal (beat the
          closing DraftKings price) and one rulebook (fair value anchored to DraftKings and never more than 12¢ away, at most 100 units on a game and market, quarter Kelly
          at most), then builds its own strategy inside it: how big an edge it demands, how tight it quotes, how far it trusts its trading firm&rsquo;s model. Each round
          plays out over twelve steps in which traders refresh quotes and hit each other&rsquo;s. Open positions are valued at DraftKings&rsquo; price (via ESPN) until they settle. No real money,
          no sportsbook, nothing connected to your bets.
        </p>
        <HealthStrip round={meta} ratings={ratingsMeta} labs={syndicates.filter((s) => s.engine === "agent").map((s) => ({ name: s.name, error: s.learn?.agent?.error, version: s.learn?.agent?.version }))} />
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted">Sort by</span>
          {SORTS.map((s) => (
            <Link key={s.key} href={sortHref(s.key, sort === s.key && dir === "desc" ? "asc" : "desc")} className={`rounded px-2.5 py-1 ${sort === s.key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
              {s.label}{sort === s.key ? (dir === "desc" ? " ▼" : " ▲") : ""}
            </Link>
          ))}
        </div>
        <p className="mb-3 text-[11px] text-muted">
          Default is closing-line value ranked by the low end of its range, because a few finished games say little about skill. Settled columns count only games that have finished; equity and open P&amp;L move with the lines.
          <span className="ml-3">By sport</span>
          {["nfl", "cfb", "nhl", "nba", "cbb"].map((s) => <Link key={s} href={`/syndicates/sports?sport=${s}`} className="ml-1 rounded px-2 py-1 text-muted hover:text-foreground">{s.toUpperCase()}</Link>)}
        </p>
        <LeaderTable rows={srowsS} linkBase="/syndicates" title="Trading firms" sort={sort} dir={dir} sortHref={sortHref} full={full} fullHref={href({ cols: full ? null : "all" })} />
        <MoneyLegend />
        <EquityChart snaps={snaps} colors={colors} names={sNames} start={start} />
        <h2 className="mb-2 text-sm font-semibold text-foreground">Traders</h2>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Spotlight title="Best closing-line value" note="Low end of the range, 10+ finished games" lists={[{ rows: bestClv, line: (r) => <span className="text-up">+{((r.clv ?? 0) * 100).toFixed(1)}¢</span> }]} />
          <Spotlight title="Most settled profit" note="Games that have finished" lists={[{ rows: bestPnl, line: (r) => <span className={r.sPnl >= 0 ? "text-up" : "text-down"}>{sgn(r.sPnl)}</span> }]} />
          <Spotlight title="24 hour movers" note="Change in equity over the last day" lists={[
            { label: "Up", rows: up, line: (r) => <span className="text-up">{sgn(r.chg24!)}</span> },
            { label: "Down", rows: down, line: (r) => <span className="text-down">{sgn(r.chg24!)}</span> },
          ]} />
          <Spotlight title="Activity" note="When each trader last traded" lists={[
            { label: "Most recent", rows: recent, line: (r) => <span className="text-muted">{r.lastApprox ? "~" : ""}{ago(r.lastTrade).text}</span> },
            { label: "Longest since a trade", rows: quiet, line: (r) => <span className="text-warn">{r.lastApprox ? "~" : ""}{ago(r.lastTrade).text}</span> },
          ]} />
          <Spotlight title="Spread captured" note="Cents per contract a quote earned inside DraftKings' price" lists={[{ rows: capture, line: (r) => <span className="text-up">+{((r.capture ?? 0) * 100).toFixed(2)}¢</span> }]} />
          <Spotlight title="Deepest drawdown" note="Largest drop from a peak, in units" lists={[{ rows: drawdown, line: (r) => <span className="text-down">-{r.maxDd.toFixed(0)}</span> }]} />
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-1 text-[11px]">
          <span className="mr-1 text-muted">Firm</span>
          <Link href={href({ syn: null, all: null })} className={`rounded px-2 py-1 ${!synFilter ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>All</Link>
          {syndicates.map((s) => <Link key={s.id} href={href({ syn: s.name, all: null })} className={`rounded px-2 py-1 ${synFilter === s.name ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>{s.name}</Link>)}
        </div>
        <LeaderTable rows={mrowsS} linkBase="/syndicates/traders" showSyn title={synFilter ? `${synFilter} traders` : "Every trader"} sort={sort} dir={dir} sortHref={sortHref} full={full} fullHref={href({ cols: full ? null : "all" })} pageSize={q.all === "1" ? undefined : 25} />
        {q.all !== "1" && mrowsS.length > 25 && <p className="-mt-6 mb-8 text-[11px]"><Link href={href({ all: "1" })} className="text-accent hover:underline">Show all {mrowsS.length} traders</Link></p>}
        <TradeList trades={trades} games={games} names={names} moreHref="/syndicates/trades" />
      </main>
    </div>
  );
}
