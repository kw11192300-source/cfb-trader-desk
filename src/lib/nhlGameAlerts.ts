import { getBets, type GradedBet } from "./data";
import { nhlBetClv } from "./nhlBetClv";
import { fmtOdds } from "./nhlModel";
import { sendTelegram } from "./nhlOdds";
import { supabaseAdmin } from "./supabase-admin";
import type { NhlMarket, NhlPrediction } from "./types";

// Two messages per game, sent from the same 10-minute timer as the odds update (so "10 minutes before" means 0-12 minutes
// before, depending on where the tick falls):
//   puck drop  - the goalies and your bets on the game, with where DraftKings is now against your price
//   final      - the score and how each bet settled
// Only games you have a logged bet on, unless NHL_ALERT_ALL_GAMES=1. Each is sent once per game (remembered in the game's
// stored market under `alerts`).

const ALL_GAMES = process.env.NHL_ALERT_ALL_GAMES === "1";
const PREGAME_WINDOW_MIN = 12;
const FINAL_FRESH_HOURS = 6; // a final older than this when we first see it is recorded silently (no flood on first run)

const nick = (t: string) => t.split(" ").slice(-1)[0];
const units = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}u`;
const timeEt = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

function betLabel(b: GradedBet["bet"], home: string): string {
  if (b.market === "moneyline" || (b.market === "spread" && Math.abs(b.line) === 0.5)) return `${b.side} ML ${fmtOdds(b.odds)}`;
  if (b.market === "spread") return `${b.side} ${b.line > 0 ? "+" : ""}${b.line} ${fmtOdds(b.odds)}`;
  if (b.market === "total") return `${b.side === "over" ? "Over" : "Under"} ${b.line} ${fmtOdds(b.odds)}`;
  if (b.market === "prop") return `${b.player ?? ""} ${b.prop_type ?? ""} ${b.side}`.trim();
  void home;
  return `${b.market} ${b.side}`;
}

type Row = { game_id: number; market: NhlMarket | null; assumptions: NhlPrediction["assumptions"] | null };

/** `dry: true` builds the messages and returns them without sending anything or marking the games as announced - for checking
 * what would go out (the cron route's `?alerts=dry`). In that mode the puck-drop window is widened to 3 hours and finals
 * from the last 36 hours are included, so there is something to see. */
export async function sendGameAlerts(opts: { dry?: boolean } = {}): Promise<{ pregame: number; final: number; messages: string[] }> {
  const dry = Boolean(opts.dry);
  const messages: string[] = [];
  const out = async (text: string) => {
    if (dry) messages.push(text);
    else await sendTelegram(text);
  };
  const now = Date.now();
  const windowMin = dry ? 180 : PREGAME_WINDOW_MIN;
  const freshHours = dry ? 36 : FINAL_FRESH_HOURS;
  const from = new Date(now - 36 * 3_600_000).toISOString();
  const to = new Date(now + windowMin * 60_000).toISOString();
  const { data: games } = await supabaseAdmin
    .from("games")
    .select("id, start_date, completed, home_team, away_team, home_points, away_points, live_status")
    .eq("sport", "nhl")
    .gte("start_date", from)
    .lte("start_date", to);
  if (!games || games.length === 0) return { pregame: 0, final: 0, messages };

  const allBets = (await getBets({ sport: "nhl", withLines: false }).catch(() => [])).filter((b) => b.bet.sport === "nhl" && b.bet.game_id !== null);
  const betsByGame = new Map<number, GradedBet[]>();
  for (const b of allBets) betsByGame.set(b.bet.game_id as number, [...(betsByGame.get(b.bet.game_id as number) ?? []), b]);

  const ids = games.map((g) => g.id as number);
  const { data: rows } = await supabaseAdmin.from("nhl_predictions").select("game_id, market, assumptions").in("game_id", ids);
  const byGame = new Map((rows ?? []).map((r) => [r.game_id as number, r as unknown as Row]));

  let pregame = 0;
  let final = 0;
  const remember = async (gameId: number, row: Row, key: string) => {
    if (dry) return;
    const market = { ...(row.market ?? {}), alerts: [...new Set([...(row.market?.alerts ?? []), key])] };
    await supabaseAdmin.from("nhl_predictions").update({ market }).eq("game_id", gameId);
    row.market = market as NhlMarket;
  };

  for (const g of games) {
    const gameId = g.id as number;
    const row = byGame.get(gameId);
    if (!row || !row.market) continue; // nowhere to remember it - skip rather than risk repeating
    const bets = betsByGame.get(gameId) ?? [];
    if (bets.length === 0 && !ALL_GAMES) continue;
    const sent = new Set(row.market.alerts ?? []);
    const start = new Date(g.start_date as string).getTime();
    const matchup = `${g.away_team} @ ${g.home_team}`;

    // ---- puck drop
    const minsToStart = (start - now) / 60000;
    if (!g.completed && !g.live_status && minsToStart > 0 && minsToStart <= windowMin && (dry || !sent.has("pregame"))) {
      const a = row.assumptions;
      const goalie = (side: "home" | "away") => {
        const top = [...(a?.goalies?.[side] ?? [])].sort((x, y) => y.weight - x.weight)[0];
        if (!top) return "?";
        return `${top.name}${a?.confirmed?.[side] ? " ✓" : " (expected)"}`;
      };
      const lines = [`⏰ Puck drop ~${Math.max(1, Math.round(minsToStart))} min: ${matchup} (${timeEt(g.start_date as string)} ET)`];
      if (a) lines.push(`Goalies: ${nick(g.away_team as string)} ${goalie("away")} · ${nick(g.home_team as string)} ${goalie("home")}`);
      if (bets.length > 0) {
        lines.push("Your bets:");
        for (const b of bets) {
          const clv = nhlBetClv(b.bet, b.game, row.market);
          const clvText = clv ? ` · now ${clv.unit === "%" ? `${clv.value >= 0 ? "+" : ""}${clv.value.toFixed(1)} pts vs your price` : `${clv.value >= 0 ? "+" : ""}${clv.value.toFixed(1)} goals vs your line`}` : "";
          lines.push(`• ${betLabel(b.bet, g.home_team as string)} - ${b.bet.stake}u${clvText}`);
        }
      }
      await out(lines.join("\n"));
      await remember(gameId, row, "pregame");
      pregame++;
    }

    // ---- final
    if (g.completed && g.home_points !== null && g.away_points !== null && (dry || !sent.has("final"))) {
      const fresh = now - start <= freshHours * 3_600_000;
      if (fresh) {
        const lines = [`🏁 Final: ${g.away_team} ${g.away_points} @ ${g.home_team} ${g.home_points}`];
        if (bets.length > 0) {
          let net = 0;
          let open = 0;
          for (const b of bets) {
            const label = betLabel(b.bet, g.home_team as string);
            if (b.status === "pending" || b.profit === null) {
              open++;
              lines.push(`• ${label} - ${b.bet.stake}u: settle by hand`);
            } else {
              net += b.profit;
              lines.push(`• ${b.status === "win" ? "✅" : b.status === "loss" ? "❌" : "➖"} ${label} - ${b.bet.stake}u → ${units(b.profit)}`);
            }
          }
          if (bets.length - open > 0) lines.push(`Net: ${units(net)}`);
        }
        await out(lines.join("\n"));
        final++;
      }
      await remember(gameId, row, "final"); // even when skipped as stale, so it is never sent later
    }
  }
  return { pregame, final, messages };
}
