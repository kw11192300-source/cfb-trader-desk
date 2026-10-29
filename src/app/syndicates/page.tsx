import { EquityChart, LeaderTable, SyndicateHeader, TradeList } from "@/components/SyndicateParts";
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
          Eight syndicates, each with its own rating system and five traders, start with 1,000 units (200 each). Every contract pays 100¢ if its side wins: the buyer
          posts the price, the seller posts the rest, so nobody can lose more than they put up. Makers post bid/ask quotes, takers hit them, and everyone is
          marked against the DraftKings price (via ESPN). No real money, no sportsbook, nothing connected to your bets.
        </p>
        <LeaderTable rows={srows} linkBase="/syndicates" title="Syndicates" />
        <EquityChart snaps={snaps} colors={colors} names={sNames} start={start} />
        <LeaderTable rows={mrows} title="Every trader" />
        <TradeList trades={trades} games={games} names={names} />
      </main>
    </div>
  );
}
