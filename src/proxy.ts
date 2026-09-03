import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, expectedCookieValue } from "@/lib/site-auth";

export async function proxy(request: NextRequest) {
  // No SITE_PASSWORD configured at all -> gate is off (e.g. local dev
  // without it set), rather than locking everyone out of a deployment
  // that never opted in.
  const expected = await expectedCookieValue();
  if (expected === null) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/login")) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (cookie === expected) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

// Everything except Next's own static/image assets and the favicon - those
// need to load on the login page itself before auth even succeeds.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
