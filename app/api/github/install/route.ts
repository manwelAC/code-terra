import { NextRequest, NextResponse } from "next/server";
import { getGitHubConfiguration, GITHUB_SESSION_COOKIE, readGitHubSession } from "@/lib/github-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const configuration = getGitHubConfiguration();
  const session = await readGitHubSession(request.cookies.get(GITHUB_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.redirect(new URL("/?onboarding=connect", request.nextUrl.origin));
  if (!configuration.appSlug) return NextResponse.redirect(new URL("/?onboarding=setup", request.nextUrl.origin));
  return NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(configuration.appSlug)}/installations/new`);
}
