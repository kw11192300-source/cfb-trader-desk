import { createClient } from "@supabase/supabase-js";

// Publishable key only — safe to expose to the browser. Every table this
// touches is public-read via RLS policies (see supabase/schema.sql); there
// is no write path from the Next.js app at all. The secret/service-role key
// is never imported here — it only exists in the Python ingestion scripts
// and GitHub Actions secrets.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variables."
  );
}

export const supabase = createClient(url, key);
