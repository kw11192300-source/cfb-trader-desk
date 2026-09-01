import Link from "next/link";

export default function SiteHeader({ subtitle }: { subtitle: string }) {
  return (
    <header className="border-b border-border bg-surface px-6 py-4">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              CFB <span className="text-accent">Trader Desk</span>
            </h1>
          </Link>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        <nav className="flex items-center gap-4 text-xs">
          <Link href="/" className="text-muted transition-colors hover:text-foreground">
            Board
          </Link>
          <Link href="/oddscreen" className="text-muted transition-colors hover:text-foreground">
            Odds Screen
          </Link>
          <Link href="/ratings" className="text-muted transition-colors hover:text-foreground">
            Ratings
          </Link>
          <div className="flex items-center gap-2 text-muted">
            <span className="h-2 w-2 rounded-full bg-up" />
            live
          </div>
        </nav>
      </div>
    </header>
  );
}
