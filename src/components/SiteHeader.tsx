import Link from "next/link";
import BottomNav from "./BottomNav";
import { OTHER_SPORT, SPORT_HOME, SPORT_LABEL, type Sport } from "./navConfig";
import Sidebar from "./Sidebar";

export type { Sport };

/** Composes the terminal's chrome: a fixed left icon rail on desktop
 * (Sidebar), a fixed bottom tab bar on mobile (BottomNav), and a slim
 * top strip - title/subtitle plus a mobile-only live/sport-switch row,
 * since Sidebar already carries those on desktop - that sits in normal
 * document flow same as the old single header did. Every page's call
 * site (`<SiteHeader subtitle=... sport=... />`) is unchanged; the
 * responsive split happens entirely inside this component. */
export default function SiteHeader({ subtitle, sport = "cfb" }: { subtitle: string; sport?: Sport }) {
  const other = OTHER_SPORT[sport];

  return (
    <>
      <Sidebar sport={sport} />
      <BottomNav sport={sport} />

      <header className="border-b border-border bg-surface px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div>
            <Link href={SPORT_HOME[sport]} prefetch={false}>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                {SPORT_LABEL[sport]} <span className="text-accent">Trader Desk</span>
              </h1>
            </Link>
            <p className="text-xs text-muted">{subtitle}</p>
          </div>

          <div className="flex items-center gap-3 text-xs md:hidden">
            <Link
              href={SPORT_HOME[other]}
              className="rounded-md border border-border px-2 py-1 font-mono font-medium text-muted transition-colors hover:border-accent hover:text-foreground"
            >
              {SPORT_LABEL[other]} →
            </Link>
            <div className="flex items-center gap-2 text-muted">
              <span className="h-2 w-2 rounded-full bg-up shadow-glow-up" />
              live
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
