import Link from "next/link";

import { EquityChart, HealthStrip, LeaderTable, MoneyLegend, SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import { getExchange, getExchangeGamesByIds, getExchangeSnapshots, getExchangeTrades, summarize } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export default async function SyndicatesPage({ searchParams }: { searchParams: Promise<{ rank?: string }> }) {
  const rankClv = (await searchParams).rank === "clv";
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
  // closing-line value is the better judge early on: rank by how far above zero we are sure it is, not by the raw average
  const lcb = (r: { clv: number | null; clvSe: number | null }) => (r.clv == null ? -9 : r.clv - 1.0 * (r.clvSe ?? 0.05));
  if (rankClv) {
    mrows.sort((a, b) => lcb(b) - lcb(a));
    srows.sort((a, b) => lcb(b) - lcb(a));
  }
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
        <div className="mb-3 flex items-center gap-2 text-[11px]">
          <span className="text-muted">Rank by</span>
          <Link href="/syndicates" className={`rounded px-2.5 py-1 ${!rankClv ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>Equity</Link>
          <Link href="/syndicates?rank=clv" className={`rounded px-2.5 py-1 ${rankClv ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>Closing-line value</Link>
          <span className="ml-3 text-muted">By sport</span>
          {["nfl", "cfb", "nhl", "nba", "cbb"].map((s) => <Link key={s} href={`/syndicates/sports?sport=${s}`} className="rounded px-2 py-1 text-muted hover:text-foreground">{s.toUpperCase()}</Link>)}
          <span className="text-muted">{rankClv ? "Sorted by the low end of each 68% range, so a big average on a few trades does not win." : "Equity moves with DraftKings lines before games finish; CLV is the steadier measure."}</span>
        </div>
        <LeaderTable rows={srows} linkBase="/syndicates" title="Syndicates" />
        <MoneyLegend />
        <EquityChart snaps={snaps} colors={colors} names={sNames} start={start} />
        <LeaderTable rows={mrows} linkBase="/syndicates/traders" showSyn title="Every trader" />
        <TradeList trades={trades} games={games} names={names} />
      </main>
    </div>
  );
}
