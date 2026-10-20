import { supabaseAdmin } from "./supabase-admin";
import { type BoxPlayer, type EspnBox, findPlayer, parseBox, propDef, settle } from "./nbaPropCatalog";
import { NBA_GAME_ID_OFFSET } from "./nbaTeams";

// Server-only: settles NBA prop bets from ESPN box scores (the catalog and the rules are in nbaPropCatalog.ts).

export type GradeResult = { checked: number; graded: number; voided: number; skipped: number };

/** Grades every ungraded NBA prop on a finished game from its box score. A manual result is never overwritten. */
export async function gradeNbaProps(): Promise<GradeResult> {
  const res: GradeResult = { checked: 0, graded: 0, voided: 0, skipped: 0 };
  const { data: bets, error } = await supabaseAdmin
    .from("bets")
    .select("id, game_id, player, prop_type, side, line, notes")
    .eq("sport", "nba")
    .eq("market", "prop")
    .is("manual_result", null)
    .not("game_id", "is", null);
  if (error || !bets || bets.length === 0) return res;
  const gameIds = [...new Set(bets.map((b) => b.game_id as number))];
  const { data: games } = await supabaseAdmin.from("games").select("id, completed").in("id", gameIds);
  const done = new Set((games ?? []).filter((g) => g.completed).map((g) => g.id as number));
  const boxes = new Map<number, BoxPlayer[] | null>();

  for (const b of bets) {
    const gid = b.game_id as number;
    if (!done.has(gid)) continue;
    res.checked++;
    const def = propDef(b.prop_type as string | null);
    if (!def || !def.auto || !def.calc || !b.player) {
      res.skipped++;
      continue;
    }
    if (!boxes.has(gid)) {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${-gid - NBA_GAME_ID_OFFSET}`, { cache: "no-store" });
        boxes.set(gid, r.ok ? parseBox((await r.json()) as EspnBox) : null);
      } catch {
        boxes.set(gid, null);
      }
    }
    const box = boxes.get(gid);
    if (!box || box.length === 0) {
      res.skipped++;
      continue;
    }
    const player = findPlayer(box, b.player as string);
    if (!player) {
      res.skipped++;
      continue;
    }
    let result: "win" | "loss" | "push";
    let note: string;
    if (player.line === null) {
      result = "push";
      note = `auto: ${player.name} did not play - bet voided`;
      res.voided++;
    } else {
      const value = def.calc(player.line);
      result = settle(def, b.side as string, Number(b.line), value);
      note = `auto: ${player.name} ${def.group === "Yes / No" ? (value >= 1 ? "yes" : "no") : Number.isInteger(value) ? value : value.toFixed(1)} ${def.label}`;
    }
    const notes = [b.notes as string | null, note].filter(Boolean).join(" · ");
    const { error: upErr } = await supabaseAdmin.from("bets").update({ manual_result: result, notes }).eq("id", b.id);
    if (!upErr) res.graded++;
  }
  return res;
}
