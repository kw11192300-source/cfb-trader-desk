import { notFound } from "next/navigation";

import { EquityChart, LeaderTable, SyndicateHeader, TradeList } from "@/components/SyndicateParts";
import { getExchange, getExchangeGamesByIds, getExchangeSnapshots, getExchangeTrades, summarize } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

export default async function SyndicatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { syndicates, members, meta } = await getExchange();
  const syn = syndicates.find((s) => s.id === id);
  if (!syn) notFound();
  const mine = members.filter((m) => m.syndicate_id === id);
  const [snaps, trades] = await Promise.all([getExchangeSnapshots("mem:" + id + "-"), getExchangeTrades({ syndicate: id, limit: 40 })]);
  const games = await getExchangeGamesByIds([...new Set(trades.map((t) => t.game_id))]);
  const { members: mrows } = summarize([syn], mine);
  const names = Object.fromEntries(members.map((m) => [m.id, `${syndicates.find((s) => s.id === m.syndicate_id)?.name ?? ""} · ${m.name}`]));
  const palette = ["#2563eb", "#7c3aed", "#ea580c", "#059669", "#dc2626"];
  const colors = Object.fromEntries(mine.map((m, i) => [m.id, palette[i % palette.length]]));
  const memberNames = Object.fromEntries(mine.map((m) => [m.id, m.name]));
  const start = Object.fromEntries(mine.map((m) => [m.id, m.start_units]));
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="board" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="text-base font-semibold text-foreground">
          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: syn.color }} />
          {syn.name}
        </h2>
        <p className="mb-6 mt-1 max-w-3xl text-xs text-muted">{syn.tagline}</p>
        <LeaderTable rows={mrows.map((r) => ({ ...r, color: colors[r.id] ?? r.color }))} title="Traders" />
        <section className="mb-8 grid gap-2 text-xs text-muted sm:grid-cols-2 lg:grid-cols-3">
          {mine.map((m) => (
            <div key={m.id} className="rounded-lg border border-border bg-surface px-3 py-2">
              <p className="font-medium text-foreground">{m.name}</p>
              <p>
                {m.role === "both" ? "Maker + taker" : m.role === "maker" ? "Maker" : "Taker"} · {m.staking} staking · {Math.round(Number(m.params.ref_w ?? 0) * 100)}% market weight
              </p>
              <p>
                {m.role !== "maker" ? `edge needed ${(Number(m.params.thr ?? 0) * 100).toFixed(0)}¢` : ""}
                {m.role !== "taker" ? `${m.role === "both" ? " · " : ""}quotes ±${(Number(m.params.half ?? 0) * 100).toFixed(1)}¢` : ""}
                {` · max ${m.params.max_risk}u per play`}
              </p>
            </div>
          ))}
        </section>
        <EquityChart snaps={snaps} colors={colors} names={memberNames} start={start} />
        <TradeList trades={trades} games={games} names={names} />
      </main>
    </div>
  );
}
