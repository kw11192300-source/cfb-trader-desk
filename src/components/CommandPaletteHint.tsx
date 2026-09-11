"use client";

/** Small discoverability hint for Cmd+K, sitting in SiteHeader's (server
 * component) top strip - extracted into its own client leaf, same
 * pattern as Sidebar/BottomNav, since SiteHeader itself has no reason to
 * be a client component otherwise. Dispatches a plain DOM event rather
 * than needing a shared toggle/context - CommandPalette listens for it. */
export default function CommandPaletteHint() {
  return (
    <button
      onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
      className="hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-accent hover:text-foreground md:flex"
    >
      Jump to…
      <span className="rounded border border-border px-1 py-0.5 text-[10px]">⌘K</span>
    </button>
  );
}
