import Image from "next/image";
import type { NbaPlayerProjection, NbaStatDist } from "@/lib/data";
import { dist, joint } from "@/lib/nbaProj";
import { nbaLogo } from "@/lib/nbaTeams";

const nameKey = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();

const COLS: { key: string; label: string; digits?: number }[] = [
  { key: "pts", label: "PTS" }, { key: "reb", label: "REB" }, { key: "ast", label: "AST" }, { key: "tpm", label: "3PM" },
  { key: "stl", label: "STL" }, { key: "blk", label: "BLK" }, { key: "tov", label: "TO" }, { key: "pra", label: "PRA" },
];

/** The expected value for the game: chance he plays and his place in the rotation included, so a column adds up to the team's number. */
const mean = (p: NbaPlayerProjection, key: string): number | null => {
  const d = dist(p, key) as NbaStatDist | undefined;
  return d ? (d.e ?? d.mean) : null;
};

/** A box score for the game that has not happened yet: each rostered player's projected minutes and average line, sorted by minutes.
 * Every number is the model's mean if he plays, blended over the in / out chances on the injury report. Heat shading is relative to
 * the team's own column so the main producers stand out. */
export default function NbaPlayerTable({ team, players, lastYear = {} }: { team: string; players: NbaPlayerProjection[]; lastYear?: Record<string, { ppg: number; mpg: number }> }) {
  const logo = nbaLogo(team);
  const active = players.filter((p) => p.p_play > 0.03 && p.min_mean !== null && (p.exp_min ?? 0) >= 1.5);
  const out = players.filter((p) => p.p_play <= 0.03 && p.base_min !== null && p.base_min >= 8).sort((a, b) => (b.base_min ?? 0) - (a.base_min ?? 0));
  const rows = [...active].sort((a, b) => (b.exp_min ?? 0) - (a.exp_min ?? 0)).slice(0, 13);
  const colMax: Record<string, number> = {};
  for (const c of COLS) colMax[c.key] = Math.max(0.01, ...rows.map((p) => mean(p, c.key) ?? 0));
  const maxMin = Math.max(1, ...rows.map((p) => p.exp_min ?? 0));
  const total = (key: string) => active.reduce((s, p) => s + (mean(p, key) ?? 0), 0);
  const totalMin = active.reduce((s, p) => s + (p.exp_min ?? 0), 0);
  // minutes vs his usual: shown relative to the team's typical change, since early in a season every starter sits below last year's playoff-heavy baseline
  const diffs = rows.filter((p) => p.min_mean !== null && p.base_min !== null && (p.n_prior ?? 0) > 0 && (joint(p)?.rot ?? 1) >= 0.9).map((p) => (p.min_mean as number) - (p.base_min as number)).sort((a, b) => a - b);
  const medDiff = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-2.5">
        {logo ? <Image src={logo} alt="" width={22} height={22} className="object-contain" style={{ width: 22, height: 22 }} unoptimized /> : null}
        <span className="text-sm font-semibold text-foreground">{team}</span>
        <span className="text-[11px] text-muted">projected box score</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted">
              <th className="sticky left-0 z-10 bg-surface px-4 py-1.5 text-left font-medium">Player</th>
              <th className="px-2 py-1.5 text-left font-medium">Min</th>
              {COLS.map((c) => (
                <th key={c.key} className="px-2 py-1.5 text-right font-medium">
                  {c.label}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-medium" title="Last season's points per game, for a sanity check against the projection">Last yr PTS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => {
              const dm = p.min_mean !== null && p.base_min !== null && (p.n_prior ?? 0) > 0 && (joint(p)?.rot ?? 1) >= 0.9 && p.p_play >= 0.97 ? p.min_mean - p.base_min - medDiff : null;
              const q = p.p_play < 0.97;
              return (
                <tr key={p.player_id} className={`border-t border-border/50 ${i % 2 ? "bg-surface-raised/30" : ""}`}>
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-surface px-4 py-1.5">
                    <span className="font-medium text-foreground">{p.name}</span>
                    {q && (
                      <span className="ml-1.5 rounded bg-warn/15 px-1 py-px text-[10px] font-medium text-warn" title={`${p.status ?? "Status"}${p.reason ? ` - ${p.reason}` : ""}. If he plays: ${p.min_mean?.toFixed(0)} min, ${((dist(p, "pts") as NbaStatDist | undefined)?.mean ?? 0).toFixed(1)} pts`}>
                        {Math.round(p.p_play * 100)}%
                      </span>
                    )}
                    {(p.n_prior ?? 0) === 0 && <span className="ml-1.5 text-[10px] text-muted">new</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-7 font-mono text-foreground">{(p.exp_min ?? 0).toFixed(0)}</span>
                      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-border/60">
                        <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.min(100, ((p.min_mean ?? 0) / maxMin) * 100)}%` }} />
                      </div>
                      {dm !== null && Math.abs(dm) >= 1.5 && (
                        <span className={`font-mono text-[10px] ${dm > 0 ? "text-up" : "text-down"}`} title={`Usual minutes ${p.base_min?.toFixed(0)}; change vs the team's typical shift`}>
                          {dm > 0 ? "+" : ""}
                          {dm.toFixed(0)}
                        </span>
                      )}
                    </div>
                  </td>
                  {COLS.map((c) => {
                    const v = mean(p, c.key);
                    const heat = v !== null ? Math.min(1, v / colMax[c.key]) : 0;
                    return (
                      <td key={c.key} className="px-2 py-1.5 text-right font-mono text-foreground" style={{ backgroundColor: heat > 0.35 ? `rgba(80,160,255,${(heat * 0.18).toFixed(3)})` : undefined }}>
                        {v === null ? "—" : v.toFixed(1)}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-right font-mono text-muted">{lastYear[nameKey(p.name)] ? lastYear[nameKey(p.name)].ppg.toFixed(1) : "—"}</td>
                </tr>
              );
            })}
            <tr className="border-t border-border bg-surface-raised/60 font-medium text-foreground">
              <td className="sticky left-0 z-10 bg-surface-raised px-4 py-1.5 text-[11px] uppercase tracking-wide text-muted">Sum of players</td>
              <td className="px-2 py-1.5 font-mono">{totalMin.toFixed(0)}</td>
              {COLS.map((c) => (
                <td key={c.key} className="px-2 py-1.5 text-right font-mono">
                  {total(c.key).toFixed(c.key === "pts" || c.key === "pra" ? 0 : 1)}
                </td>
              ))}
              <td className="px-2 py-1.5" />
            </tr>
          </tbody>
        </table>
      </div>
      {out.length > 0 && (
        <div className="border-t border-border/60 px-4 py-2 text-[11px] text-muted">
          <span className="text-down">Out:</span> {out.map((p) => `${p.name}${p.reason ? ` (${p.reason.replace(/^Injury\/Illness\s*/i, "")})` : ""}`).join(", ")}
        </div>
      )}
    </div>
  );
}
