import "server-only";
import { createClient } from "@supabase/supabase-js";

// SECRET KEY — server-only, bypasses RLS. `import "server-only"` makes any
// accidental import from a Client Component a build error rather than a
// leaked secret; never import this file from a "use client" component.
// Used exclusively by Server Actions (src/app/edges/actions.ts) to write
// to `bets` — every other table in this app is still read-only from
// Next.js, written only by the Python ingestion scripts.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY environment variables.");
}

export const supabaseAdmin = createClient(url, key);
