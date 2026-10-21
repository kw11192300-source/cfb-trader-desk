import Link from "next/link";
import { notFound } from "next/navigation";
import CbbLogo from "@/components/CbbLogo";
import LocalDateTime from "@/components/LocalDateTime";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { adjustRow } from "@/lib/cbbAvailability";
import { fairOdds } from "@/lib/nbaProj";
import { getCbbAvailability, getCbbBoardGame, getCbbSnapshots } from "@/lib/data";

export const dynamic = "force-dynamic";

const f1 = (v: number | null | undefined) => (typeof v === "number" ? v.toFixed(1) : "—");
const line = (m: number | null | undefined) => (typeof m === "number" ? `${m > 0 ? "-" : m < 0 ? "+" : ""}${Math.abs(m).toFixed(1)}` : "—");
const amer = (p: number | null | undefined) => (typeof p === "number" ? (p > 0 ? `+${p}` : `${p}`) : "—");
const pct = (p: number | null | undefined) => (typeof p === "number" ? `${(p * 100).toFixed(1)}%` : "—");
/** A probability with its fair American price: "57.3% (-134)". */
const po = (p: number | null | undefined) => (typeof p === "number" ? `${(p * 100).toFixed(1)}% (${fairOdds(p)})` : "—");
const sg = (v: number | null | undefined, d = 1) => (typeof v === "number" ? `${v > 0 ? "+" : ""}${v.toFixed(d)}` : "—");

/** A small inline line chart of one series over time with the open and our expected close marked. */
function Series({ pts, expClose, label, unit }: { pts: { t: number; v: number }[]; expClose: number | null; label: string; unit: string }) {
  if (pts.length === 0) return <div className="rounded-lg border border-border bg-surface p-4 text-xs text-muted">No {label.toLowerCase()} history logged yet.</div>;
  const w = 520;
  const h = 150;
  const pad = 28;
  const vals = pts.map((p) => p.v).concat(expClose !== null ? [expClose] : []);
  const lo = Math.min(...vals) - 0.5;
  const hi = Math.max(...vals) + 0.5;
  const t0 = pts[0].t;
  const t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const x = (t: number) => pad + ((t - t0) / (t1 - t0)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - pad * 2);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted">
          {unit === "line" ? `${line(pts[0].v)} → ${line(pts[pts.length - 1].v)}` : `${f1(pts[0].v)} → ${f1(pts[pts.length - 1].v)}`}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
        {expClose !== null && (
          <g>
            <line x1={pad} x2={w - pad} y1={y(expClose)} y2={y(expClose)} stroke="var(--accent)" strokeDasharray="4 4" strokeWidth="1" />
            <text x={w - pad} y={y(expClose) - 4} textAnchor="end" fontSize="10" fill="var(--accent)">
              expected close {unit === "line" ? line(expClose) : f1(expClose)}
            </text>
          </g>
        )}
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" />
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r={i === 0 || i === pts.length - 1 ? 3 : 1.6} fill="currentColor" />
        ))}
        <text x={pad} y={h - 8} fontSize="10" fill="var(--muted)">
          <LocalDateTime iso={new Date(t0).toISOString()} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
        </text>
        <text x={w - pad} y={h - 8} textAnchor="end" fontSize="10" fill="var(--muted)">
          <LocalDateTime iso={new Date(t1).toISOString()} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
        </text>
      </svg>
    </div>
  );
}

export default async function CbbGamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gameId = Number(id);
  if (!Number.isFinite(gameId)) notFound();
  const [game, snaps, avail] = await Promise.all([getCbbBoardGame(gameId), getCbbSnapshots(gameId), getCbbAvailability(2026)]);
  if (!game) notFound();
  const p = game.payload;
  const adj = adjustRow(game, avail);
  const outCount = adj.home.length + adj.away.length;
  const mSpread = adj.spread ?? p.model.spread;
  const mTotal = adj.total ?? p.model.total;
  const mWin = adj.homeWin ?? p.model.home_win;
  const home = p.teams?.home ?? game.home_team;
  const away = p.teams?.away ?? game.away_team;
  const spreadPts = snaps.filter((s) => s.spread_home_line !== null).map((s) => ({ t: new Date(s.captured_at).getTime(), v: -(s.spread_home_line as number) }));
  const totalPts = snaps.filter((s) => s.total_line !== null).map((s) => ({ t: new Date(s.captured_at).getTime(), v: s.total_line as number }));
  const sp = p.bets.spread;
  const tt = p.bets.total;
  const ml = p.bets.ml;
  const d = p.drivers;
  const T = ({ id: tid, name }: { id: number | null; name: string }) => (
    <Link href={tid ? `/cbb/teams/${tid}` : "#"} className="flex items-center gap-2 hover:text-accent">
      <CbbLogo teamId={tid} size={30} />
      <span className="text-lg font-semibold">{name}</span>
    </Link>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Game" sport="cbb" />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-4">
          <T id={game.away_team_id} name={away} />
          <span className="text-muted">@</span>
          <T id={game.home_team_id} name={home} />
          <span className="ml-auto text-sm text-muted">
            <LocalDateTime iso={game.start_date} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted">Our projection</div>
            <div className="text-2xl font-semibold">
              {home} {line(mSpread)}{outCount > 0 ? "*" : ""}
            </div>
            <div className="mt-1 text-sm text-muted">
              Total {f1(mTotal)}{outCount > 0 ? "*" : ""} · {away} {f1(((mTotal ?? 0) - (mSpread ?? 0)) / 2)} - {home} {f1(((mTotal ?? 0) + (mSpread ?? 0)) / 2)}
            </div>
            <div className="mt-2 text-xs text-muted">
              {home} win {po(mWin)} · fair ML {amer(p.model.fair_ml_home)} / {amer(p.model.fair_ml_away)} (before availability) · pace {f1(p.model.poss)}
            </div>
            {outCount > 0 && (
              <div className="mt-2 text-[11px] text-warn">
                * adjusted for {outCount} player{outCount === 1 ? "" : "s"} out: {sg(adj.dMargin)} margin, {sg(adj.dTotal)} total vs the base model ({line(p.model.spread)} / {f1(p.model.total)})
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted">Market</div>
            <div className="text-sm">
              Spread {line(p.market.open_margin)} → <span className="font-semibold">{line(p.market.cur_margin)}</span>
              <span className="ml-2 text-muted">(home line)</span>
            </div>
            <div className="text-sm">
              Total {f1(p.market.open_total)} → <span className="font-semibold">{f1(p.market.cur_total)}</span>
            </div>
            <div className="text-xs text-muted">
              ML {amer(p.market.ml_home)} / {amer(p.market.ml_away)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted">Where we expect it to close</div>
            <div className="text-sm">
              Spread <span className="font-semibold">{line(p.move.exp_close_margin)}</span>
              <span className="ml-2 text-muted">{sg(p.move.spread)} from the open</span>
            </div>
            <div className="text-sm">
              Total <span className="font-semibold">{f1(p.move.exp_close_total)}</span>
              <span className="ml-2 text-muted">{sg(p.move.total)} from the open</span>
            </div>
            <div className="text-xs text-muted">ML home implied {po(ml.cur_p_home)} now → {po(ml.exp_close_p_home)} expected</div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="mb-3 text-[11px] uppercase tracking-wide text-muted">Closing-line-value plays at today&apos;s number</div>
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div>
              <div className="text-muted">Spread</div>
              {sp.side ? (
                <div className="text-base font-semibold text-up">
                  {sp.side === "home" ? home : away} <span className="font-mono text-sm">+{sp.clv?.toFixed(1)} pts</span>
                </div>
              ) : (
                <div className="text-muted">no edge to the close</div>
              )}
              <div className="text-xs text-muted">{home} covers today&apos;s number {po(sp.p_cover_home)} by our own price</div>
            </div>
            <div>
              <div className="text-muted">Total</div>
              {tt.side ? (
                <div className="text-base font-semibold text-up">
                  {tt.side.toUpperCase()} <span className="font-mono text-sm">+{tt.clv?.toFixed(1)} pts</span>
                </div>
              ) : (
                <div className="text-muted">no edge to the close</div>
              )}
              <div className="text-xs text-muted">Over {po(tt.p_over)} by our own price</div>
            </div>
            <div>
              <div className="text-muted">Moneyline</div>
              {ml.side ? (
                <div className="text-base font-semibold text-up">
                  {ml.side === "home" ? home : away} <span className="font-mono text-sm">+{Math.abs((ml.clv_p ?? 0) * 100).toFixed(1)}% implied</span>
                </div>
              ) : (
                <div className="text-muted">no edge to the close</div>
              )}
              <div className="text-xs text-muted">expected shift in implied win probability by the close</div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Series pts={spreadPts} expClose={p.move.exp_close_margin} label="Home spread" unit="line" />
          <Series pts={totalPts} expClose={p.move.exp_close_total} label="Total" unit="total" />
        </div>

        <div className="rounded-lg border border-border bg-surface p-4 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-muted">Availability</span>
            <span className="flex gap-3">
              <Link href={`/cbb/availability?team=${game.away_team_id ?? ""}`} className="text-accent hover:underline">
                Mark {away} player
              </Link>
              <Link href={`/cbb/availability?team=${game.home_team_id ?? ""}`} className="text-accent hover:underline">
                Mark {home} player
              </Link>
            </span>
          </div>
          {outCount === 0 ? (
            <p className="text-muted">Nobody marked out for either team. A missing rotation player is worth roughly 1-3 points of margin.</p>
          ) : (
            <ul className="space-y-1">
              {[...adj.away.map((e) => ({ ...e, team: away })), ...adj.home.map((e) => ({ ...e, team: home }))].map((e) => (
                <li key={e.id} className="text-foreground">
                  {e.name} <span className="text-muted">({e.team})</span> <span className="text-warn">{e.status}</span>{" "}
                  <span className="font-mono text-muted">
                    -{e.margin.toFixed(1)} margin · {e.total.toFixed(1)} total
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface p-4 text-xs text-muted">
          <div className="mb-1 text-[11px] uppercase tracking-wide">What is driving the move</div>
          Our number is {sg(d.gap_s)} from the open spread and {sg(d.gap_t)} from the open total. Recent results against the market (last 10 games, points per game
          the market missed): {home} {sg(d.f10_m_h)}, {away} {sg(d.f10_m_a)}. Rest: {home} {f1(d.rest_h)} days, {away} {f1(d.rest_a)} days.
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
