import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getNights, getOvernight, type Row, scoreNights, snapshotTime } from "@/lib/overnight";
import { getExchange } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const HOURS = [19, 20, 21, 22];
const cents = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}¢`;
const num = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const hourLabel = (h: number) => `${h > 12 ? h - 12 : h} PM`;
const tone = (n: number | null, eps = 0) => (n == null || Math.abs(n) <= eps ? "text-muted" : n > 0 ? "text-up" : "text-down");

/** The side of a market a positive number points to. */
function sideWord(r: Row, positive: boolean): string {
  const [away, home] = r.teams.split(" @ ");
  if (r.kind === "total") return positive ? "Over" : "Under";
  if (r.kind === "ml") return `${positive ? home : away} ML`;
  return positive ? `${home}` : `${away}`;
}

/** What DraftKings' number reads like to a bettor. */
function lineText(r: Row, line: number): string {
  const [, home] = r.teams.split(" @ ");
  if (r.kind === "spread") return `${home} ${num(line)}`;
  if (r.kind === "total") return `${line}`;
  return "";
}

/** What the evidence says about which way a number may go, in the same words as the market: the movement model, the sharp flow and the exchange against DraftKings. */
function direction(r: Row): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = [];
  const word = (positive: boolean) => sideWord(r, positive);
  if (r.mm && r.mm.side && r.mm.ageH <= 12 && (r.mm.clv ?? 0) >= 0.3) out.push({ text: `movement model: ${r.mm.side === "home" || r.mm.side === "over" ? word(true) : word(false)} by ${r.mm.clv!.toFixed(1)}`, cls: "text-up" });
  if (Math.abs(r.netW) >= 40) out.push({ text: `sharp flow: ${word(r.netW > 0)}`, cls: "text-foreground" });
  if (r.gap != null && Math.abs(r.gap) >= 0.01) out.push({ text: `exchange ${r.gap > 0 ? word(true) : word(false)} ${cents(Math.abs(r.gap))}`, cls: "text-muted" });
  return out;
}

function reads(r: Row): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = [];
  if (!r.snap) out.push({ text: "opened since", cls: "text-accent" });
  const dir = r.kind === "ml" ? Math.sign(r.pMove ?? 0) : Math.sign(r.lineMove ?? 0);
  const big = r.kind === "ml" ? Math.abs(r.pMove ?? 0) >= 0.015 : Math.abs(r.lineMove ?? 0) >= (r.kind === "total" ? 1.5 : 1);
  const sharpDir = Math.abs(r.netW) >= 40 ? Math.sign(r.netW) : 0;
  if (sharpDir && big) {
    out.push(dir === sharpDir ? { text: "sharps with the move", cls: "text-up" } : { text: "moved against the sharps", cls: "text-down" });
  } else if (sharpDir) out.push({ text: "sharps leaning", cls: "text-foreground" });
  if (r.gap != null && Math.abs(r.gap) >= 0.01) {
    const gdir = Math.sign(r.gap);
    out.push({ text: `exchange ${gdir > 0 ? "higher" : "lower"} than DK`, cls: sharpDir && gdir === sharpDir ? "text-up" : "text-muted" });
  }
  return out;
}

export default async function OvernightPage({ searchParams }: { searchParams: Promise<{ at?: string; sport?: string; all?: string }> }) {
  const sp = await searchParams;
  const hour = HOURS.includes(Number(sp.at)) ? Number(sp.at) : 20;
  const sport = SPORT[sp.sport ?? ""] ? sp.sport! : "";
  const showAll = sp.all === "1";
  const since = snapshotTime(hour);
  const { members, meta } = await getExchange();
  const { rows, games, posted, newlyPosted } = await getOvernight(since, members);
  const nights = await getNights();
  const record = scoreNights(nights);
  const synName: Record<string, string> = {};
  for (const m of members) synName[m.syndicate_id] = m.syndicate_id;
  const { syndicates } = await getExchange();
  for (const s of syndicates) synName[s.id] = s.name;

  const filtered = rows.filter((r) => !sport || r.sport === sport);
  const notable = filtered.filter((r) => showAll || r.score >= 1);
  const shown = [...notable].sort((a, b) => b.score - a.score).slice(0, 80);
  const hoursAgo = (Date.now() - since.getTime()) / 3600000;
  const q = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const all = { at: sp.at, sport: sp.sport, all: sp.all, ...o };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/syndicates/overnight${p.toString() ? `?${p}` : ""}`;
  };
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;

  // the accounts worth listening to on this slate: best sharp score across the sports shown, with how far DraftKings moved toward what they took
  const sportsOn = new Set(filtered.map((r) => r.sport));
  const watch = members
    .filter((m) => !m.params.public && !m.params.lab)
    .map((m) => {
      const best = [...sportsOn].map((s) => [s, Number((m.stats.sharp ?? {})[s] ?? 0)] as const).sort((a, b) => b[1] - a[1])[0];
      return { m, sport: best?.[0] ?? "", s: best?.[1] ?? 0, drift: m.stats.drift_taker_n ? (m.stats.drift_taker_sum ?? 0) / m.stats.drift_taker_n : null, n: m.stats.drift_taker_n ?? 0 };
    })
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10);

  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="overnight" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Overnight board: what moved since the evening, and who is trading it</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Compares each game&rsquo;s DraftKings numbers now with where they stood at the snapshot (default 8 PM ET, when the next day&rsquo;s lines are up), and shows where the exchange sits against DraftKings and where the accounts with a
          closing-line record have traded since. <strong>Sharp flow</strong> is only what they did after the snapshot, weighted by how sharp each is, and the names show how far DraftKings moved toward what each has taken (its DK move).
          The read in the last column is a prompt to look, not a bet: sharps who are with the move have usually already been paid, and sharps the market moved against are offside.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
          <div className="flex items-center gap-1">
            <span className="mr-1 text-muted">Snapshot</span>
            {HOURS.map((h) => <Link key={h} href={q({ at: String(h) })} className={chip(h === hour)}>{hourLabel(h)} ET</Link>)}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted">Sport</span>
            <Link href={q({ sport: undefined })} className={chip(!sport)}>All</Link>
            {Object.entries(SPORT).map(([k, v]) => <Link key={k} href={q({ sport: k })} className={chip(sport === k)}>{v}</Link>)}
          </div>
          <div className="flex items-center gap-1">
            <Link href={q({ all: undefined })} className={chip(!showAll)}>Notable only</Link>
            <Link href={q({ all: "1" })} className={chip(showAll)}>Every line</Link>
          </div>
        </div>

        <p className="mb-3 text-[11px] text-muted">
          Snapshot <LocalDateTime iso={since.toISOString()} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> ({hoursAgo.toFixed(0)} h ago) · {games} games still to play in the next 36 hours · {posted} with a DraftKings line · {newlyPosted} posted since the snapshot · {shown.length} of {filtered.length} lines shown
        </p>

        {(() => {
          const cand = filtered.filter((r) => r.expMove != null && !r.live && r.kind !== "ml").sort((a, b) => (b.expMove ?? 0) - (a.expMove ?? 0)).slice(0, 8);
          const ages = filtered.filter((r) => r.mm).map((r) => r.mm!.ageH);
          const minAge = ages.length ? Math.min(...ages) : null;
          return (
            <section className="mb-8">
              <h3 className="mb-1 text-sm font-semibold text-foreground">Most likely to move before the close</h3>
              <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
                Ranked by how far the number is likely to travel, not which way. The size comes from a week of games: college basketball moves most, totals more than spreads, the lowest-tier games most of all, and more where the exchange&rsquo;s own line was far from what DraftKings posted.
                Direction is shown only where there is evidence for it, and none of it is proven yet: the saved nights below build the record.
                {minAge != null && minAge > 12 ? <span className="text-warn"> The CBB movement model is working from a board {minAge.toFixed(0)} hours old, so its calls are hidden: refresh the board first.</span> : null}
              </p>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Game</th><th className="px-3 py-2">Market</th><th className="px-3 py-2 text-right">DraftKings now</th><th className="px-3 py-2 text-right">Likely to move</th><th className="px-3 py-2">Evidence for a direction</th></tr></thead>
                  <tbody className="font-mono">
                    {cand.length === 0 ? <tr><td colSpan={5} className="px-3 py-6 text-center font-sans text-muted">No spreads or totals posted for the games still to play.</td></tr> : cand.map((r) => {
                      const dir = direction(r);
                      return (
                        <tr key={`c${r.game}${r.kind}`} className="border-t border-border">
                          <td className="px-3 py-1.5 font-sans text-foreground"><Link href={`/syndicates/games/${encodeURIComponent(r.game)}`} className="hover:text-accent">{r.teams}</Link><span className="ml-1.5 text-[10px] uppercase text-muted">{SPORT[r.sport]}</span><span className="block text-[10px] text-muted"><LocalDateTime iso={r.start} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />{r.postedH != null ? ` · up ${r.postedH.toFixed(0)} h` : ""}</span></td>
                          <td className="px-3 py-1.5 font-sans text-muted">{r.kind === "spread" ? "Spread" : "Total"}</td>
                          <td className="px-3 py-1.5 text-right">{lineText(r, r.now.line)}</td>
                          <td className="px-3 py-1.5 text-right text-accent">~{r.expMove!.toFixed(1)} pts</td>
                          <td className="px-3 py-1.5 font-sans">{dir.length === 0 ? <span className="text-muted">no direction signal</span> : dir.map((x) => <span key={x.text} className={`mr-3 inline-block ${x.cls}`}>{x.text}</span>)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })()}

        <h3 className="mb-2 text-sm font-semibold text-foreground">Everything since the snapshot</h3>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1000px] text-xs">
            <thead className="bg-surface text-left text-muted">
              <tr>
                <th className="px-3 py-2">Game</th>
                <th className="px-3 py-2">Market</th>
                <th className="px-3 py-2 text-right" title="DraftKings' number at the snapshot and now (the spread is the home team's, as the exchange lists it; for a moneyline, the home team's fair price)">DraftKings</th>
                <th className="px-3 py-2 text-right" title="How far the number moved toward the home side or the over (points), or the home fair price (cents) on a moneyline or on a line that did not change">Moved</th>
                <th className="px-3 py-2 text-right" title="Exchange price minus DraftKings' price now, on the same contract, on the home side or the over">Exchange vs DK</th>
                <th className="px-3 py-2" title="Net trading since the snapshot by accounts with a closing-line record (sharp score 0.3 or more), weighted by sharpness. Names show their DK move: how far DraftKings moved toward what they took">Sharp flow since</th>
                <th className="px-3 py-2">Read</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {shown.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-8 text-center font-sans text-muted">Nothing notable since the snapshot{sport ? ` in ${SPORT[sport]}` : ""}. Try &ldquo;Every line&rdquo;.</td></tr>
              ) : shown.map((r) => {
                const rd = reads(r);
                const net = Math.abs(r.netW) >= 10 ? sideWord(r, r.netW > 0) : null;
                return (
                  <tr key={`${r.game}${r.kind}`} className="border-t border-border align-top">
                    <td className="px-3 py-1.5 font-sans text-foreground">
                      <Link href={`/syndicates/games/${encodeURIComponent(r.game)}`} className="hover:text-accent">{r.teams}</Link>
                      <span className="ml-1.5 text-[10px] uppercase text-muted">{SPORT[r.sport]}</span>
                      <span className="block text-[10px] text-muted">{r.live ? <span className="text-accent">live</span> : <LocalDateTime iso={r.start} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}</span>
                    </td>
                    <td className="px-3 py-1.5 font-sans text-muted">{r.kind === "ml" ? "Moneyline" : r.kind === "spread" ? "Spread" : "Total"}</td>
                    <td className="px-3 py-1.5 text-right">
                      {r.kind === "ml" ? (
                        <>{r.snap ? `${(r.snap.p * 100).toFixed(1)}¢ → ` : "– → "}{(r.now.p * 100).toFixed(1)}¢</>
                      ) : (
                        <>{r.snap ? `${lineText(r, r.snap.line)} → ` : "posted: "}{lineText(r, r.now.line)}{!r.snap && r.internal != null ? <span className="block text-[10px] text-muted">we had {lineText(r, r.internal)}</span> : null}</>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {r.kind !== "ml" && r.lineMove != null && r.lineMove !== 0 ? <span className={tone(r.lineMove)}>{r.lineMove > 0 ? "▲" : "▼"} {Math.abs(r.lineMove)} pt{Math.abs(r.lineMove) === 1 ? "" : "s"}</span> : null}
                      {r.pMove != null && (r.kind === "ml" || r.lineMove === 0) ? <span className={tone(r.pMove, 0.002)}>{cents(r.pMove)}</span> : null}
                      {r.pMove != null && r.kind !== "ml" && r.lineMove === 0 ? null : null}
                      {r.lineMove == null && r.pMove == null ? <span className="text-muted">–</span> : null}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${tone(r.gap, 0.004)}`}>{r.gap == null ? <span className="text-muted">–</span> : cents(r.gap)}</td>
                    <td className="px-3 py-1.5 font-sans">
                      {net ? (
                        <>
                          <span className="font-semibold text-foreground">{net}</span> <span className="font-mono text-muted">{Math.abs(r.netW).toFixed(0)}</span>
                          <span className="block text-[10px] text-muted">
                            {r.who.map((w, i) => (
                              <span key={w.name}>{i > 0 && " · "}{w.name} ({synName[w.firm]}{w.drift != null ? ` ${cents(w.drift)}` : ""})</span>
                            ))}
                          </span>
                          <span className="block text-[10px] text-muted">{r.sharpQ.toFixed(0)} sharp of {r.tradedQ.toFixed(0)} contracts traded</span>
                        </>
                      ) : (
                        <span className="text-muted">{r.tradedQ > 0 ? `${r.tradedQ.toFixed(0)} contracts, no sharp lean` : "no trades"}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-sans">
                      {rd.length === 0 ? <span className="text-muted">–</span> : rd.map((x) => <span key={x.text} className={`mr-2 inline-block ${x.cls}`}>{x.text}</span>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h3 className="mb-1 text-sm font-semibold text-foreground">Saved nights: did the calls hold up?</h3>
        <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">
          Every night at about 8 PM ET the exchange saves this board (sharp leans, the movement model, the volatility rank) and scores it once the games finish. <strong>Toward</strong> counts the number moving the way it was called, from the saved number to the close.
          Spreads and totals only. A call only means something once there are a few hundred of them.
        </p>
        {nights.length === 0 ? (
          <p className="mb-8 rounded-lg border border-border bg-surface px-4 py-6 text-center text-xs text-muted">The first snapshot is saved by the first exchange round after 8 PM ET; scoring starts once those games finish.</p>
        ) : (
          <div className="mb-8">
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                ["Sharp leans (40+ weighted contracts)", record.acc.lean.n, record.acc.lean.toward, record.acc.lean.pts],
                ["Movement model calls (0.5+ pts)", record.acc.mm.n, record.acc.mm.toward, record.acc.mm.pts],
              ].map(([k, n, toward, pts]) => (
                <div key={String(k)} className="rounded-lg border border-border bg-surface px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted">{k}</div>
                  <div className="font-mono text-lg text-foreground">{Number(n) ? `${toward}/${n} toward` : "none scored yet"}</div>
                  <div className={`text-[10px] ${Number(n) && Number(pts) > 0 ? "text-up" : Number(n) && Number(pts) < 0 ? "text-down" : "text-muted"}`}>{Number(n) ? `${Number(pts) / Number(n) >= 0 ? "+" : ""}${(Number(pts) / Number(n)).toFixed(2)} pts per call on average` : ""}</div>
                </div>
              ))}
              <div className="rounded-lg border border-border bg-surface px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">Volatility rank: top 8 each night vs the rest</div>
                <div className="font-mono text-lg text-foreground">{record.acc.top.n ? `${(record.acc.top.abs / record.acc.top.n).toFixed(2)} vs ${record.acc.rest.n ? (record.acc.rest.abs / record.acc.rest.n).toFixed(2) : "–"} pts` : "none scored yet"}</div>
                <div className="text-[10px] text-muted">average size of the move to the close</div>
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[720px] text-xs">
                <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Night</th><th className="px-3 py-2 text-right">Lines saved</th><th className="px-3 py-2 text-right">Scored</th><th className="px-3 py-2 text-right">Sharp leans toward</th><th className="px-3 py-2 text-right">Movement model toward</th><th className="px-3 py-2 text-right">Top-8 move</th><th className="px-3 py-2 text-right">Rest</th></tr></thead>
                <tbody className="font-mono">
                  {record.perNight.map((n) => (
                    <tr key={n.date} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground">{n.date}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{n.rows}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{n.scored}</td>
                      <td className="px-3 py-1.5 text-right">{n.lean.n ? `${n.lean.toward}/${n.lean.n} (${n.lean.pts / n.lean.n >= 0 ? "+" : ""}${(n.lean.pts / n.lean.n).toFixed(1)})` : "–"}</td>
                      <td className="px-3 py-1.5 text-right">{n.mm.n ? `${n.mm.toward}/${n.mm.n} (${n.mm.pts / n.mm.n >= 0 ? "+" : ""}${(n.mm.pts / n.mm.n).toFixed(1)})` : "–"}</td>
                      <td className="px-3 py-1.5 text-right">{n.topAbs == null ? "–" : `${n.topAbs.toFixed(1)} pts`}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{n.restAbs == null ? "–" : `${n.restAbs.toFixed(1)} pts`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <h3 className="mb-1 text-sm font-semibold text-foreground">Accounts worth listening to on this slate</h3>
        <p className="mb-2 max-w-3xl text-[11px] leading-relaxed text-muted">Sharp score 0.5 or more in a sport on the board. DK move is how far DraftKings moved toward what they took after they took it, per contract (their takes only). A small count means a small sample.</p>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Trader</th><th className="px-3 py-2">Firm</th><th className="px-3 py-2">Sport</th><th className="px-3 py-2 text-right">Sharp</th><th className="px-3 py-2 text-right">DK move</th><th className="px-3 py-2 text-right">Takes</th></tr></thead>
            <tbody className="font-mono">
              {watch.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center font-sans text-muted">No account is above 0.5 on this slate.</td></tr> : watch.map((w) => (
                <tr key={w.m.id} className="border-t border-border">
                  <td className="px-3 py-1.5 font-sans text-foreground"><Link href={`/syndicates/${w.m.syndicate_id}`} className="hover:text-accent">{w.m.name}</Link></td>
                  <td className="px-3 py-1.5 font-sans text-muted">{synName[w.m.syndicate_id]}</td>
                  <td className="px-3 py-1.5 font-sans text-muted">{SPORT[w.sport]}</td>
                  <td className="px-3 py-1.5 text-right">{w.s.toFixed(2)}</td>
                  <td className={`px-3 py-1.5 text-right ${tone(w.drift, 0.002)}`}>{w.drift == null ? "–" : cents(w.drift)}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{w.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
