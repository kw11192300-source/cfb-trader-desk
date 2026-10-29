import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { type ExGame, getExchangeBoard, label, pct } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT_LABEL: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const KIND = { ml: "Moneyline", spread: "Spread", total: "Total" } as const;

function Ladder({ g }: { g: ExGame }) {
  const book = g.book ?? [];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {(["ml", "spread", "total"] as const).map((k) => {
        const rows = book.filter((r) => r[0] === k).sort((a, b) => a[1] - b[1]);
        if (!rows.length) return null;
        return (
          <table key={k} className="w-full text-[11px]">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-0.5 font-medium">{KIND[k]}</th>
                <th className="py-0.5 text-right font-medium">Fair</th>
                <th className="py-0.5 text-right font-medium">Bid</th>
                <th className="py-0.5 text-right font-medium">Ask</th>
                <th className="py-0.5 text-right font-medium">Last</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r) => (
                <tr key={`${r[0]}${r[1]}`} className="border-t border-border">
                  <td className="py-0.5 font-sans text-foreground">{label({ kind: r[0], line: r[1] }, g)}</td>
                  <td className="py-0.5 text-right text-muted">{pct(r[2])}</td>
                  <td className="py-0.5 text-right">{pct(r[3])}</td>
                  <td className="py-0.5 text-right">{pct(r[4])}</td>
                  <td className="py-0.5 text-right text-accent">{pct(r[5])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}

export default async function SyndicateMarketsPage() {
  const games = await getExchangeBoard();
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="markets" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <p className="mb-6 max-w-3xl text-xs leading-relaxed text-muted">
          Each game lists a moneyline and a ladder of spread and total lines around DraftKings&rsquo; main number. <em>Fair</em> is the DraftKings price with the vig taken
          out (a yes contract pays 100¢: home wins, home covers, over). <em>Bid</em> and <em>Ask</em> are the best quotes left from the last round, <em>Last</em> the last trade.
        </p>
        {games.length === 0 && <p className="text-sm text-muted">No games on the exchange yet.</p>}
        <div className="space-y-4">
          {games.map((g) => (
            <section key={g.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">
                  <span className="mr-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-muted">{SPORT_LABEL[g.sport]}</span>
                  {g.away.name} @ {g.home.name}
                </h3>
                <span className="text-[11px] text-muted">
                  <LocalDateTime iso={g.start_utc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                </span>
              </div>
              <Ladder g={g} />
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
