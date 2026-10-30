import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getNews, type NewsEvent } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORTS = ["nba", "nhl", "nfl"];
const SPORT: Record<string, string> = { nfl: "NFL", nhl: "NHL", nba: "NBA" };
const sg = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const OUT = /out|doubtful|injured|ir|suspend/i;

function move(e: NewsEvent, key: "r1" | "r2") {
  const a = e.r0, b = e[key];
  if (!a || !b) return null;
  const ds = a.spread != null && b.spread != null ? b.spread - a.spread : null;
  const dt = a.total != null && b.total != null ? b.total - a.total : null;
  const xs = a.x?.spread != null && b.x?.spread != null ? (b.x.spread - a.x.spread) * 100 : null;
  const xt = a.x?.total != null && b.x?.total != null ? (b.x.total - a.x.total) * 100 : null;
  return { ds, dt, xs, xt };
}

export default async function NewsPage({ searchParams }: { searchParams: Promise<{ sport?: string; tied?: string }> }) {
  const sp = await searchParams;
  const sport = SPORTS.includes(sp.sport ?? "") ? sp.sport! : null;
  const tied = sp.tied === "1";
  const [events, { meta }] = await Promise.all([getNews(), getExchange()]);
  const list = events.filter((e) => (!sport || e.sport === sport) && (!tied || e.gid));
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  const q = (o: { sport?: string | null; tied?: boolean }) => {
    const p = new URLSearchParams();
    const s = o.sport === undefined ? sport : o.sport, t = o.tied === undefined ? tied : o.tied;
    if (s) p.set("sport", s);
    if (t) p.set("tied", "1");
    return `/syndicates/news${p.toString() ? `?${p}` : ""}`;
  };
  // average reaction two hours after events that were tied to a game: how far DraftKings' spread and total moved, and how far the exchange's prices moved
  const looked = list.map((e) => ({ e, m: move(e, "r2") })).filter((x) => x.m);
  const avg = (f: (m: NonNullable<ReturnType<typeof move>>) => number | null) => {
    const v = looked.map((x) => f(x.m!)).filter((n): n is number => n != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const absAvg = (f: (m: NonNullable<ReturnType<typeof move>>) => number | null) => {
    const v = looked.map((x) => f(x.m!)).filter((n): n is number => n != null);
    return v.length ? v.reduce((a, b) => a + Math.abs(b), 0) / v.length : null;
  };
  const stat = [
    ["News events seen", String(events.length)],
    ["Tied to a game", String(events.filter((e) => e.gid).length)],
    ["Checked 2 h later", String(looked.length)],
    ["DK spread moved (avg)", absAvg((m) => m.ds) == null ? "–" : `${absAvg((m) => m.ds)!.toFixed(2)} pts`],
    ["Exchange spread price moved (avg)", absAvg((m) => m.xs) == null ? "–" : `${absAvg((m) => m.xs)!.toFixed(1)}¢`],
  ];
  void avg;
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="news" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Shared news: injuries and availability, and how the market reacts</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Every round the exchange reads ESPN&rsquo;s injury lists (NBA, NHL and NFL) and compares them with the last ones. A player added, a status change, or a player cleared is an event, and every group and lab sees it at the same moment
          (the labs receive the current injury list and recent events for both teams of each game). When a team has a game in the next three days, the DraftKings line and the exchange&rsquo;s prices on that game are noted when the event is seen and again
          about 30 minutes and 2 hours later, so you can see which reacted first and by how much. History starts when the feed was turned on; nothing is shown for lists that were already there.
        </p>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {stat.map(([k, v]) => <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-muted">{k}</p><p className="text-lg font-semibold text-foreground">{v}</p></div>)}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
          <div className="flex gap-1"><span className="py-1 text-muted">Sport</span>
            <Link href={q({ sport: null })} className={chip(!sport)}>All</Link>
            {SPORTS.map((s) => <Link key={s} href={q({ sport: s })} className={chip(sport === s)}>{SPORT[s]}</Link>)}
          </div>
          <div className="flex gap-1"><span className="py-1 text-muted">Show</span>
            <Link href={q({ tied: false })} className={chip(!tied)}>Every event</Link>
            <Link href={q({ tied: true })} className={chip(tied)}>Only events before a game</Link>
          </div>
        </div>
        {list.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            No events yet. The feed took its first snapshot of the injury lists on the last round, so the first events appear as soon as a status changes.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[960px] text-xs">
              <thead className="bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-2">Seen</th><th className="px-3 py-2">Event</th><th className="px-3 py-2">Next game</th><th className="px-3 py-2 text-right">DK at the time</th>
                  <th className="px-3 py-2 text-right" title="Change in DraftKings' spread and total, and in the exchange's prices on the main spread and total, 30 minutes later">30 min later</th>
                  <th className="px-3 py-2 text-right">2 hours later</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {list.slice(0, 80).map((e) => {
                  const m1 = move(e, "r1"), m2 = move(e, "r2");
                  const cell = (m: ReturnType<typeof move>) =>
                    !m ? <span className="text-muted">{e.gid ? "waiting" : "–"}</span> : (
                      <span>
                        <span className="text-foreground">DK {m.ds == null ? "–" : sg(m.ds)} / {m.dt == null ? "–" : sg(m.dt)}</span>
                        <span className="ml-2 text-muted">ex {m.xs == null ? "–" : `${sg(m.xs, 0)}¢`} / {m.xt == null ? "–" : `${sg(m.xt, 0)}¢`}</span>
                      </span>
                    );
                  return (
                    <tr key={e.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap px-3 py-1.5 font-sans text-muted"><LocalDateTime iso={e.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                      <td className="px-3 py-1.5 font-sans">
                        <span className="mr-1.5 text-[10px] text-muted">{SPORT[e.sport]}</span>
                        <span className="text-foreground">{e.player}</span> <span className="text-muted">({e.pos ?? "?"}, {e.team_name})</span>
                        <span className={`block text-[11px] ${OUT.test(e.status) ? "text-down" : e.kind === "cleared" ? "text-up" : "text-muted"}`}>
                          {e.kind === "added" ? "added to the list: " : e.kind === "cleared" ? "cleared, was " : `${e.prev ?? "?"} → `}{e.status}{e.detail ? ` · ${e.detail}` : ""}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-sans">
                        {e.gid ? <><Link href={`/syndicates/games/${encodeURIComponent(e.gid)}`} className="text-foreground hover:text-accent">{e.teams}</Link>{e.start && <span className="block text-[11px] text-muted"><LocalDateTime iso={e.start} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} /></span>}</> : <span className="text-muted">no game in the next 3 days</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right text-muted">{e.r0 ? `${e.r0.spread ?? "–"} / ${e.r0.total ?? "–"}` : "–"}</td>
                      <td className="px-3 py-1.5 text-right">{cell(m1)}</td>
                      <td className="px-3 py-1.5 text-right">{cell(m2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 max-w-3xl text-[11px] text-muted">
          Reaction columns: DK is the change in DraftKings&rsquo; spread and total in points; ex is the change in the exchange&rsquo;s own price on the main spread and total contracts, in cents. A big move at DraftKings and a small one on the exchange
          means the exchange is slow to react, and the reverse means it priced the news first.
        </p>
      </main>
    </div>
  );
}
