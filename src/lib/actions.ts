"use server";

import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";

/** Logs a real bet. Called from a <form action={logBet}> in a Client
 * Component - the action itself runs server-side only (that's what "use
 * server" means), so supabaseAdmin's secret key never reaches the browser
 * even though the form triggering it (on /edges) is client-rendered. Lives
 * here rather than under app/edges since deleteBet is also used from /bets. */
export async function logBet(formData: FormData): Promise<void> {
  const game_id = Number(formData.get("game_id"));
  const model_version = (formData.get("model_version") as string) || null;
  const market = (formData.get("market") as string) || "spread";
  const side = formData.get("side") as string;
  const line = Number(formData.get("line"));
  const oddsRaw = formData.get("odds");
  const odds = oddsRaw && String(oddsRaw).trim() !== "" ? Number(oddsRaw) : -110;
  const stake = Number(formData.get("stake"));
  const sportsbook = (formData.get("sportsbook") as string) || null;
  const edgeSourceRaw = formData.get("edge_source") as string;
  const edge_source = ["model", "market", "both"].includes(edgeSourceRaw) ? edgeSourceRaw : "model";
  const notes = (formData.get("notes") as string) || null;

  if (!game_id || !side || Number.isNaN(line) || !stake || stake <= 0 || Number.isNaN(odds)) {
    throw new Error("Missing or invalid bet fields.");
  }

  const { error } = await supabaseAdmin
    .from("bets")
    .insert({ game_id, model_version, market, side, line, odds, stake, sportsbook, edge_source, notes });
  if (error) throw new Error(error.message);

  revalidatePath("/bets");
}

/** Removes a logged bet (e.g. a typo, or a bet that never actually got
 * placed) - takes the id directly since this is called via a bound form
 * action (see BetsLedger.tsx), not a raw <form>. */
export async function deleteBet(id: number): Promise<void> {
  const { error } = await supabaseAdmin.from("bets").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/bets");
}
