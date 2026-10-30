import Link from "next/link";

import { EquityChart, HealthStrip, LeaderTable, MoneyLegend, SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import { getExchange, getExchangeGamesByIds, getExchangeSnapshots, getExchangeTrades, SORTS, sortRows, summarize } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export default async function SyndicatesPage({ searchParams }: { searchParams: Promise<{ sort?: string; dir?: string }> }) {
  const q = await searchParams;
  const sort = SORTS.some((s) => s.key === q.sort) ? q.sort! : "clvlow";
  const dir = q.dir === "asc" ? "asc" : "desc";
  const sortHref = (k: string, d: "asc" | "desc") => `/syndicates?sort=${k}&dir=${d}`;
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
  const [snaps, trades] = await Promise.all([getExchangeSnapshots("syn:"), getExchangeTrades({ limit: 40 })]);
  const games = await getExchangeGamesByIds([...new Set(trades.map((t) => t.game_id))]);
  const { members: mrows, syndicates: srows } = summarize(syndicates, members);
  const mrowsS = sortRows(mrows, sort, dir);
  const srowsS = sortRows(srows, sort, dir);
  const names = Object.fromEntries(members.map((m) => [m.id, `${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""} · ${m.name}`]));
  const colors = Object.fromEntries(syndicates.map((s) => [s.id, s.color]));
  const sNames = Object.fromEntries(syndicates.map((s) => [s.id, s.name]));
  const start = Object.fromEntries(syndicates.map((s) => [s.id, s.start_units]));
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="board" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-6 max-w-3xl text-xs leading-relaxed text-muted">
          Eight syndicates, each with its own rating system, start with 10,000 units split across five sport desks (NFL, CFB, NHL, NBA, CBB). A contract pays 1 unit
          if its side wins: the buyer posts the price, the seller posts the rest, so nobody can lose more than they put up. Every trader shares one goal (beat the
          closing DraftKings price) and one rulebook (fair value anchored to DraftKings and never more than 12¢ away, at most 100 units on a game and market, quarter Kelly
          at most), then builds its own strategy inside it: how big an edge it demands, how tight it quotes, how far it trusts its syndicate&rsquo;s model. Each round
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
        <LeaderTable rows={srowsS} linkBase="/syndicates" title="Syndicates" sort={sort} dir={dir} sortHref={sortHref} />
        <MoneyLegend />
        <EquityChart snaps={snaps} colors={colors} names={sNames} start={start} />
        <LeaderTable rows={mrowsS} linkBase="/syndicates/traders" showSyn title="Every trader" sort={sort} dir={dir} sortHref={sortHref} />
        <TradeList trades={trades} games={games} names={names} moreHref="/syndicates/trades" />
      </main>
    </div>
  );
}
