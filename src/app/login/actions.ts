"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, COOKIE_NAME, expectedCookieValue } from "@/lib/site-auth";

export async function login(formData: FormData): Promise<void> {
  const password = (formData.get("password") as string) ?? "";
  const next = (formData.get("next") as string) || "/";

  if (!checkPassword(password)) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const value = await expectedCookieValue();
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: value!, // checkPassword already confirmed SITE_PASSWORD is set, so this can't be null
    httpOnly: true, // never readable from client-side JS
    secure: process.env.NODE_ENV === "production", // localhost has no HTTPS to require
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  redirect(next);
}
