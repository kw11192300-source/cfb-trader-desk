import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getExchangeBoard, pct, type ExGame } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["cbb", "nba", "nhl", "cfb", "nfl"];
const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const WINDOWS: [number, string][] = [[24, "24 hours"], [48, "2 days"], [72, "3 days"], [168, "7 days"]];
const LINES: [string, string][] = [["main", "Main lines"], ["near", "Near the main line (within 2)"], ["all", "Every line"]];
const MIN_GAP = 2; // cents: at or above this a row is shown on its own merit; with fewer than FLOOR_N such rows the biggest few are shown anyway
const FLOOR_N = 5;
const CAP = 60;

type Params = { sport?: string; h?: string; lines?: string };
type Flow = [number, number] | undefined;

/** The side the exchange prices higher than DraftKings does, in words (yes = home for the moneyline and spread, over for a total). */
const leans = (g: ExGame, kind: string, line: number, gap: number) => {
  const yes = gap > 0;
  if (kind === "ml") return `${yes ? g.home.abbr : g.away.abbr} to win`;
  if (kind === "spread") return yes ? `${g.home.abbr} ${line > 0 ? "+" : ""}${line}` : `${g.away.abbr} ${-line > 0 ? "+" : ""}${-line}`;
  return `${yes ? "Over" : "Under"} ${line}`;
};

export default async function DifferencesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const hours = WINDOWS.find(([h]) => String(h) === sp.h)?.[0] ?? 48;
  const lineMode = LINES.find(([k]) => k === sp.lines)?.[0] ?? "main";
  const [board, { meta }] = await Promise.all([getExchangeBoard(hours), getExchange()]);
  const inScope = board.filter((g) => (!sport || g.sport === sport) && new Date(g.start_utc).getTime() > Date.now());
  const dk = inScope.filter((g) => (g.ref?.src ?? "dk") === "dk");
  const noDk = inScope.length - dk.length;

  const q = (o: Partial<Params>) => {
    const p = new URLSearchParams();
    const all: Params = { sport: sport ?? undefined, h: hours === 48 ? undefined : String(hours), lines: lineMode === "main" ? undefined : lineMode, ...o };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/syndicates/differences${p.toString() ? `?${p}` : ""}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;

  type Row = { g: ExGame; kind: string; line: number; dk: number; x: number; gap: number; bid: number; ask: number; bsz: number | null; asz: number | null; last: number | null; flow: Flow };
  const rows: Row[] = [];
  for (const g of dk) {
    const flow = (g.views as unknown as { flow?: [number, number] } | null)?.flow;
    for (const r of g.book ?? []) {
      const [kind, line, dkp, bid, ask, last, , bsz, asz, x] = r;
      if (x == null || dkp == null || bid == null || ask == null) continue; // a price with no two-sided book behind it is a stale last trade, not a view
      const main = g.ref?.[kind === "spread" ? "spread" : "total"];
      if (kind !== "ml") {
        if (main == null) continue;
        const off = Math.abs(line - main);
        if (lineMode === "main" && off > 0.5 + 1e-9) continue;
        if (lineMode === "near" && off > 2 + 1e-9) continue;
      }
      rows.push({ g, kind, line, dk: dkp, x, gap: (x - dkp) * 100, bid, ask, bsz, asz, last, flow });
    }
  }
  rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const strong = rows.filter((r) => Math.abs(r.gap) >= MIN_GAP);
  const fallback = strong.length < FLOOR_N;
  const shown = fallback ? rows.slice(0, FLOOR_N) : strong.slice(0, CAP);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="differences" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Biggest differences: where the exchange is furthest from DraftKings</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Every line on a game DraftKings has priced, ranked by how far the exchange&rsquo;s price is from DraftKings&rsquo; price (vig removed), in cents. A price counts only if the book has both a bid and an ask behind it. Rows at {MIN_GAP}¢ or more are all shown; when fewer than {FLOOR_N}{" "}
          qualify, the {FLOOR_N} biggest are shown anyway. The exchange stays close to DraftKings by design, so most gaps are small, and so far a gap on its own has not predicted where DraftKings goes next; the lean is a lead, not a signal.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Sport</span>
            <Link href={q({ sport: undefined })} className={chip(!sport)}>All</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Starts within</span>
            {WINDOWS.map(([h, name]) => <Link key={h} href={q({ h: h === 48 ? undefined : String(h) })} className={chip(hours === h)}>{name}</Link>)}
          </div>
          <div className="flex flex-wrap gap-1"><span className="py-1 text-muted">Lines</span>
            {LINES.map(([k, name]) => <Link key={k} href={q({ lines: k === "main" ? undefined : k })} className={chip(lineMode === k)}>{name}</Link>)}
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Games with a DraftKings line", String(dk.length)],
            ["Lines compared", String(rows.length)],
            [`At ${MIN_GAP}¢ or more`, String(strong.length)],
            ["Biggest gap", rows.length ? `${Math.abs(rows[0].gap).toFixed(1)}¢` : "–"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>
          ))}
        </div>
        {noDk > 0 && <p className="mb-3 text-[11px] text-muted">{noDk} game{noDk === 1 ? "" : "s"} in this window have no DraftKings line yet, so there is nothing to compare; see the Ratings panel page for those.</p>}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">No lines to compare at this setting.</p>
        ) : (
          <>
            {fallback && <p className="mb-2 rounded border border-border bg-surface px-3 py-2 text-[11px] text-muted">Nothing is {MIN_GAP}¢ or more apart at this setting, so these are the {shown.length} biggest.</p>}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[900px] text-xs">
                <thead className="bg-surface text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Game</th>
                    <th className="px-3 py-2">Exchange leans to</th>
                    <th className="px-3 py-2 text-right">DraftKings</th>
                    <th className="px-3 py-2 text-right">Exchange</th>
                    <th className="px-3 py-2 text-right">Gap</th>
                    <th className="px-3 py-2 text-right" title="Best bid and ask, with the size at each">Book</th>
                    <th className="px-3 py-2 text-right">Last trade</th>
                    <th className="px-3 py-2 text-right" title="How far sharp money has shifted the game's expected margin and total, in points">Sharp flow</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {shown.map((r) => (
                    <tr key={`${r.g.id}${r.kind}${r.line}`} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 font-sans text-foreground">
                        <span className="mr-1.5 text-[10px] text-muted">{SPORT[r.g.sport]}</span>
                        <Link href={`/syndicates/games/${encodeURIComponent(r.g.id)}`} className="hover:text-accent">{r.g.away.abbr} @ {r.g.home.abbr}</Link>
                        <div className="text-[10px] text-muted"><LocalDateTime iso={r.g.start_utc} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></div>
                      </td>
                      <td className="px-3 py-1.5 font-sans font-medium text-accent">{leans(r.g, r.kind, r.line, r.gap)}</td>
                      <td className="px-3 py-1.5 text-right">{(r.dk * 100).toFixed(1)}¢</td>
                      <td className="px-3 py-1.5 text-right">{(r.x * 100).toFixed(1)}¢</td>
                      <td className={`px-3 py-1.5 text-right font-semibold ${Math.abs(r.gap) >= MIN_GAP ? "text-accent" : "text-foreground"}`}>{r.gap > 0 ? "+" : ""}{r.gap.toFixed(1)}¢</td>
                      <td className="px-3 py-1.5 text-right text-muted">{pct(r.bid)} × {r.bsz != null ? Math.round(r.bsz) : "–"} / {pct(r.ask)} × {r.asz != null ? Math.round(r.asz) : "–"}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{pct(r.last)}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{r.flow && (Math.abs(r.flow[0]) >= 0.05 || Math.abs(r.flow[1]) >= 0.05) ? `${r.flow[0] >= 0 ? "+" : ""}${r.flow[0].toFixed(2)} / ${r.flow[1] >= 0 ? "+" : ""}${r.flow[1].toFixed(2)}` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!fallback && strong.length > CAP && <p className="mt-2 text-[11px] text-muted">Showing the top {CAP} of {strong.length}. Narrow by sport or time to see the rest.</p>}
          </>
        )}
      </main>
    </div>
  );
}
