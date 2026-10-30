import Link from "next/link";

import LocalDateTime from "@/components/LocalDateTime";
import { SyndicateHeader } from "@/components/SyndicateParts";
import { getExchange, getSignals, type Signal } from "@/lib/syndicates";

export const dynamic = "force-dynamic";

const SPORT: Record<string, string> = { cfb: "CFB", nfl: "NFL", nhl: "NHL", cbb: "CBB", nba: "NBA" };
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const se = (a: number[]) => (a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : null);
const c1 = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}¢`;
const tone = (n: number) => (n > 0.001 ? "text-up" : n < -0.001 ? "text-down" : "text-muted");

function stat(set: Signal[]) {
  const mv = set.map((s) => s.moved!), pl = set.map((s) => s.pnl_dk!);
  return { n: set.length, mv: mean(mv), mvSe: se(mv), pl: mean(pl), plSe: se(pl), hit: set.length ? set.filter((s) => s.pnl_dk! > 0).length / set.length : null };
}

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const sp = await searchParams;
  const type = sp.type === "gap" || sp.type === "sharp" ? sp.type : null;
  const [{ open, done }, { meta }] = await Promise.all([getSignals(), getExchange()]);
  const d = done.filter((s) => !type || s.type === type);
  const o = open.filter((s) => !type || s.type === type);
  const groups: [string, Signal[]][] = [
    ["All", d],
    ["Exchange gap from DraftKings", d.filter((s) => s.type === "gap")],
    ["Sharp flow", d.filter((s) => s.type === "sharp")],
    ["Under 6 hours before the game", d.filter((s) => s.hrs < 6)],
    ["6 to 24 hours", d.filter((s) => s.hrs >= 6 && s.hrs < 24)],
    ["More than 24 hours", d.filter((s) => s.hrs >= 24)],
    ["Gap of 3¢ or more", d.filter((s) => s.size >= 0.03)],
    ...Object.keys(SPORT).map((k) => [SPORT[k], d.filter((s) => s.sport === k)] as [string, Signal[]]),
  ];
  const chip = (on: boolean) => `rounded px-2.5 py-1 ${on ? "bg-accent text-background" : "text-muted hover:text-foreground"}`;
  const tw = (s: Signal) => `${s.teams} · ${s.kind === "ml" ? "ML" : s.kind === "spread" ? `spread ${s.line}` : `total ${s.line}`} · ${s.side > 0 ? "yes" : "no"}`;
  return (
    <div className="flex min-h-screen flex-col">
      <SyndicateHeader active="signals" round={meta} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <h2 className="mb-1 text-base font-semibold text-foreground">Signal log: when the exchange disagrees with DraftKings, who turns out right?</h2>
        <p className="mb-4 max-w-3xl text-xs leading-relaxed text-muted">
          Paper only, and not a betting signal. The first time one of a game&rsquo;s main lines shows a disagreement, it is logged with the prices at that moment: either the exchange&rsquo;s price sits 2¢ or more from DraftKings&rsquo;
          (<em>gap</em>, whoever caused it), or traders with a closing-line record have pushed the price 1¢ or more (<em>sharp</em>, which needs someone to have earned that record first). When the game ends it is scored:
          <strong> did DraftKings&rsquo; close move toward it</strong> (the cleanest test, no luck from the result), and <strong>what a contract on its side made at DraftKings&rsquo; price</strong> (noisy, so look at the range). Only games DraftKings priced count.
        </p>
        <div className="mb-4 flex items-center gap-1 text-[11px]">
          <span className="py-1 text-muted">Kind</span>
          <Link href="/syndicates/signals" className={chip(!type)}>Both</Link>
          <Link href="/syndicates/signals?type=gap" className={chip(type === "gap")}>Gap</Link>
          <Link href="/syndicates/signals?type=sharp" className={chip(type === "sharp")}>Sharp</Link>
          <span className="ml-3 text-muted">{d.length} scored · {o.length} waiting on their games</span>
        </div>

        {!d.length ? (
          <p className="mb-8 rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">Nothing scored yet: entries are scored as their games finish.</p>
        ) : (
          <div className="mb-8 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">Group</th><th className="px-3 py-2 text-right">Scored</th><th className="px-3 py-2 text-right" title="Average move of DraftKings' price from the moment of the signal to the close, in the signal's direction">DraftKings moved toward it</th><th className="px-3 py-2 text-right" title="Average profit per contract following the signal at DraftKings' price at the time">Made at DK price</th><th className="px-3 py-2 text-right">Right</th></tr></thead>
              <tbody className="font-mono">
                {groups.map(([name, set]) => {
                  if (!set.length) return null;
                  const s = stat(set);
                  return (
                    <tr key={name} className="border-t border-border">
                      <td className="px-3 py-1.5 font-sans text-foreground">{name}</td>
                      <td className="px-3 py-1.5 text-right text-muted">{s.n}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(s.mv)}`}>{c1(s.mv)}{s.mvSe != null && <span className="ml-1 text-[10px] text-muted">±{(196 * s.mvSe).toFixed(1)}</span>}</td>
                      <td className={`px-3 py-1.5 text-right ${tone(s.pl)}`}>{c1(s.pl)}{s.plSe != null && <span className="ml-1 text-[10px] text-muted">±{(196 * s.plSe).toFixed(1)}</span>}</td>
                      <td className="px-3 py-1.5 text-right">{s.hit == null ? "–" : `${(s.hit * 100).toFixed(0)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="mb-2 text-sm font-semibold text-foreground">Latest scored</h3>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[820px] text-xs">
            <thead className="bg-surface text-left text-muted"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Signal</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2 text-right">Hours out</th><th className="px-3 py-2 text-right">DK then</th><th className="px-3 py-2 text-right">Exchange then</th><th className="px-3 py-2 text-right">DK close</th><th className="px-3 py-2 text-right">Happened</th></tr></thead>
            <tbody className="font-mono">
              {d.slice(0, 30).map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-3 py-1.5 text-muted"><LocalDateTime iso={s.ts} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /></td>
                  <td className="px-3 py-1.5 font-sans text-foreground"><Link href={`/syndicates/games/${encodeURIComponent(s.game)}`} className="hover:text-accent">{tw(s)}</Link></td>
                  <td className="px-3 py-1.5 font-sans text-muted">{s.type}</td>
                  <td className="px-3 py-1.5 text-right text-muted">{s.hrs}</td>
                  <td className="px-3 py-1.5 text-right">{(s.ref * 100).toFixed(1)}¢</td>
                  <td className="px-3 py-1.5 text-right">{s.x == null ? "–" : `${(s.x * 100).toFixed(1)}¢`}</td>
                  <td className={`px-3 py-1.5 text-right ${tone(s.moved!)}`}>{(s.dk_close! * 100).toFixed(1)}¢</td>
                  <td className={`px-3 py-1.5 text-right ${tone(s.pnl_dk!)}`}>{s.y === 1 ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
