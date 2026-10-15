import CbbBoardTable from "@/components/CbbBoardTable";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { getCbbAvailability, getCbbBoard } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function CbbMoversPage() {
  const [rows, avail] = await Promise.all([
    getCbbBoard(new Date(Date.now() - 6 * 3_600_000).toISOString(), new Date(Date.now() + 5 * 86_400_000).toISOString()),
    getCbbAvailability(2026),
  ]);
  const bySpread = [...rows].sort((a, b) => Math.abs(b.payload.move.remaining_spread ?? 0) - Math.abs(a.payload.move.remaining_spread ?? 0)).slice(0, 25);
  const byTotal = [...rows].sort((a, b) => Math.abs(b.payload.move.remaining_total ?? 0) - Math.abs(a.payload.move.remaining_total ?? 0)).slice(0, 25);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader subtitle="Expected movers" sport="cbb" />
      <main className="mx-auto w-full max-w-[1500px] flex-1 space-y-8 px-6 py-6">
        <div className="max-w-5xl rounded-lg border border-border bg-surface p-4 text-xs leading-relaxed text-muted">
          Which lines we expect to move the most before tip, and by how much. Spread moves are the more reliable list (the biggest predicted movers really do move
          about twice as far as a typical game); total moves are good for direction and a rough size at the extremes, but not for ranking small ones.
        </div>
        <section>
          <h2 className="mb-2 text-sm font-semibold">Spreads - biggest expected moves</h2>
          <CbbBoardTable rows={bySpread} initialSort="mover" showDays={false} avail={avail} />
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold">Totals - biggest expected moves</h2>
          <CbbBoardTable rows={byTotal} initialSort="total" showDays={false} avail={avail} />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
