import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = params.next ?? "/";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <form action={login} className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <h1 className="mb-1 text-lg font-semibold tracking-tight text-foreground">
          CFB <span className="text-accent">Trader Desk</span>
        </h1>
        <p className="mb-4 text-xs text-muted">Enter the password to continue.</p>
        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="password"
          autoFocus
          required
          placeholder="Password"
          className="mb-3 w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {params.error && <p className="mb-3 text-xs text-down">Wrong password.</p>}
        <button
          type="submit"
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Enter
        </button>
      </form>
    </div>
  );
}
