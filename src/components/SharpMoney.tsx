import Link from "next/link";

import { gameCards } from "@/lib/positions";
import { type ExGame, type ExMember, fairOf, type Lot, pct, TRADER_GAME_LIMIT } from "@/lib/syndicates";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const c1 = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}¢`;

export type Tier = "sharp" | "leaning" | "slight" | "none" | "public";
export const TIERS: Record<Tier, { name: string; color: string }> = {
  sharp: { name: "Sharp", color: "#f59e0b" },
  leaning: { name: "Leaning sharp", color: "#fbbf24" },
  slight: { name: "Slight record", color: "#a8a29e" },
  none: { name: "No record yet", color: "#57534e" },
  public: { name: "Public money", color: "#f97316" },
};

/** How much a trader's takes in a sport have earned a place on the sharp list: its closing-line record as a taker, 0 to 1. */
export const sharpOf = (m: ExMember, sport: string): number => (m.params.public ? 0 : Number((m.stats.sharp ?? {})[sport] ?? 0));
export const tierOf = (m: ExMember, sport: string): Tier => {
  if (m.params.public) return "public";
  const s = sharpOf(m, sport);
  return s >= 0.5 ? "sharp" : s >= 0.2 ? "leaning" : s > 0.02 ? "slight" : "none";
};

/** Rank of a trader among all traders in a sport by sharpness (1 = the sharpest), or null when it has no record there. */
export function rankIn(members: ExMember[], m: ExMember, sport: string): number | null {
  const s = sharpOf(m, sport);
  if (s <= 0.02) return null;
  return 1 + members.filter((x) => sharpOf(x, sport) > s).length;
}

export function SharpMoney({ game, lots, members, synName, synColor }: { game: ExGame; lots: Lot[]; members: ExMember[]; synName: Record<string, string>; synColor: Record<string, string> }) {
  const sport = game.sport;
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const holders = [...new Set(lots.map((l) => l.holder))].map((h) => byId[h]).filter(Boolean);
  const rows = holders.map((m) => {
    const ls = lots.filter((l) => l.holder === m.id);
    const card = gameCards(ls, { [game.id]: game }, fairOf)[0];
    const s = sharpOf(m, sport);
    const fl = (m.stats.flow ?? {})[sport] as { s: number; w: number } | undefined;
    const limit = TRADER_GAME_LIMIT * (1 + 0.5 * s);
    return { m, s, tier: tierOf(m, sport), rank: rankIn(members, m, sport), w: fl?.w ?? 0, clv: fl && fl.w > 0 ? fl.s / fl.w : null, card, limit, used: card ? -card.worst : 0, bankroll: m.cash + m.locked };
  }).filter((r) => r.card);
  const sharp = rows.filter((r) => r.s >= 0.1).sort((a, b) => b.s - a.s);

  // where the sharp money leans: contracts held by each sharp trader, weighted by how sharp it is
  const lean: Record<string, { kind: string; line: number; v: number }> = {};
  for (const r of sharp) {
    for (const l of lots.filter((x) => x.holder === r.m.id)) {
      const k = `${l.kind}|${l.line}`;
      (lean[k] ??= { kind: l.kind, line: l.line, v: 0 }).v += l.qty * r.s;
    }
  }
  const sideWords = (kind: string, line: number, v: number) =>
    kind === "ml" ? `${v >= 0 ? game.home.abbr : game.away.abbr} to win` : kind === "spread" ? (v >= 0 ? `${game.home.abbr} ${line > 0 ? "+" : ""}${line}` : `${game.away.abbr} ${-line > 0 ? "+" : ""}${-line}`) : `${v >= 0 ? "Over" : "Under"} ${line}`;
  const leans = Object.values(lean).filter((x) => Math.abs(x.v) >= 1).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 4);
  const everyone = members.filter((m) => !m.params.public && sharpOf(m, sport) > 0.02).length;

  return (
    <section className="mb-8">
      <h3 className="mb-1 text-sm font-semibold text-foreground">Where the sharpest accounts are: {SPORT[sport]} record on this game</h3>
      <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-muted">
        A trader&rsquo;s sharpness in a sport comes from its record as a taker: how often the price it paid was beaten by the close, with more weight as the trades pile up. It is 0 to 1, per sport, and early on it is thin: {everyone} of {members.length} accounts
        have any {SPORT[sport]} record at all. Treat the order as a lead, not a verdict. &ldquo;Leverage&rdquo; is how much of the account&rsquo;s per-game limit the worst case on this game uses, and how much of its bankroll.
      </p>
      {sharp.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">No account with a {SPORT[sport]} closing-line record holds a position in this game yet.</p>
      ) : (
        <>
          {leans.length > 0 && (
            <p className="mb-3 text-xs text-foreground">
              Biggest sharp-weighted positions:{" "}
              {leans.map((x, i) => (
                <span key={`${x.kind}${x.line}`}>{i > 0 && ", "}<span className="font-semibold text-accent">{sideWords(x.kind, x.line, x.v)}</span> <span className="font-mono text-muted">({Math.abs(x.v).toFixed(0)} sharp-weighted)</span></span>
              ))}
              .
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[860px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-2">Trader</th>
                  <th className="px-3 py-2">{SPORT[sport]} sharpness</th>
                  <th className="px-3 py-2 text-right" title="Average closing-line value per contract on its takes in this sport, and how many trades' worth of evidence">Record</th>
                  <th className="px-3 py-2">Holds on this game</th>
                  <th className="px-3 py-2 text-right" title="Worst case on this game as a share of its per-game limit">Leverage</th>
                </tr>
              </thead>
              <tbody>
                {sharp.map((r) => (
                  <tr key={r.m.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 text-foreground">
                      <Link href={`/syndicates/traders/${r.m.id}`} className="font-medium hover:text-accent">{r.m.name}</Link>
                      <span className="block text-[10px] text-muted"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: synColor[r.m.syndicate_id] }} />{synName[r.m.syndicate_id]}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 rounded bg-surface-raised"><div className="h-1.5 rounded" style={{ width: `${r.s * 100}%`, background: TIERS[r.tier].color }} /></div>
                        <span className="font-mono text-[11px] text-foreground">{r.s.toFixed(2)}</span>
                      </div>
                      <span className="text-[10px] text-muted">{TIERS[r.tier].name}{r.rank ? ` · #${r.rank} of ${everyone} in ${SPORT[sport]}` : ""}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px]">
                      <span className={r.clv != null && r.clv > 0 ? "text-up" : "text-down"}>{r.clv == null ? "–" : c1(r.clv)}</span>
                      <span className="block text-[10px] text-muted">{r.w.toFixed(0)} trades&rsquo; weight</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.card!.legs.map((l) => (
                          <span key={`${l.kind}${l.line}`} className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]">
                            <span className="font-medium text-foreground">{l.text}</span>
                            <span className="ml-1 font-mono text-muted">{Math.abs(l.net).toFixed(0)} @ {pct(l.paid)}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px]">
                      <span className="text-foreground">{r.used.toFixed(0)}</span> <span className="text-muted">/ {r.limit.toFixed(0)}</span>
                      <div className="ml-auto mt-1 h-1 w-16 rounded bg-surface-raised"><div className={`h-1 rounded ${r.used > r.limit * 0.9 ? "bg-down" : "bg-accent"}`} style={{ width: `${Math.min(100, (r.used / r.limit) * 100)}%` }} /></div>
                      <span className="text-[10px] text-muted">{((r.used / Math.max(1, r.bankroll)) * 100).toFixed(1)}% of bankroll</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
