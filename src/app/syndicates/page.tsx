import { EquityChart, LeaderTable, MoneyLegend, SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import { getExchange, getExchangeGamesByIds, getExchangeSnapshots, getExchangeTrades, summarize } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export default async function SyndicatesPage() {
  const { syndicates, members, meta, configured } = await getExchange();
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
        <LeaderTable rows={srows} linkBase="/syndicates" title="Syndicates" />
        <MoneyLegend />
        <EquityChart snaps={snaps} colors={colors} names={sNames} start={start} />
        <LeaderTable rows={mrows} title="Every trader" />
        <TradeList trades={trades} games={games} names={names} />
      </main>
    </div>
  );
}
