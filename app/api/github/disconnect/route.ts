import { NextResponse } from "next/server";
import { GITHUB_SESSION_COOKIE, githubCookieOptions } from "@/lib/github-auth";

export async function POST() {
  const response = NextResponse.json({ connected: false });
  response.cookies.set(GITHUB_SESSION_COOKIE, "", { ...githubCookieOptions(0), maxAge: 0 });
  return response;
}
