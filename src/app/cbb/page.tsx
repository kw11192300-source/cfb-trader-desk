import CbbBoardTable from "@/components/CbbBoardTable";
import LocalDateTime from "@/components/LocalDateTime";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCbbAvailability, getCbbBoard } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function CbbBoardPage() {
  const from = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const to = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const [rows, avail] = await Promise.all([getCbbBoard(from, to), getCbbAvailability(2026)]);
  const flagged = rows.filter((r) => Math.max(r.spread_clv ?? 0, r.total_clv ?? 0) >= 1).length;
  const updated = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), "");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Board" sport="cbb" />
      <main className="mx-auto w-full max-w-[1500px] flex-1 px-6 py-6">
        <div className="mb-4 max-w-5xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          <p>
            Every game with what we project, where we expect each line to <span className="text-foreground">close</span>, and the side that should gain{" "}
            <span className="text-foreground">closing-line value (CLV)</span> if you take today&apos;s number. <span className="text-foreground">Exp. close</span> is
            the open plus our predicted move; the play is the side that line should travel toward, and the number next to it is the expected points of CLV. Spreads
            are the home team&apos;s line (− means the home team is favoured). Positive CLV over many bets is the thing that predicts profit; a single game is
            noise.
          </p>
          {rows.length > 0 && (
            <p className="mt-2">
              {rows.length} games scored · <span className="text-foreground">{flagged}</span> with 1+ points of expected CLV on a spread or total
              {updated && (
                <>
                  {" "}· updated <LocalDateTime iso={updated} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }} />
                </>
              )}
            </p>
          )}
        </div>
        <CbbBoardTable rows={rows} avail={avail} />
      </main>
      <SiteFooter />
    </div>
  );
}
