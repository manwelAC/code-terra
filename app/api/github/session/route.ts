import { NextRequest, NextResponse } from "next/server";
import { getGitHubConfiguration, GITHUB_SESSION_COOKIE, readGitHubSession } from "@/lib/github-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const configuration = getGitHubConfiguration();
  const session = await readGitHubSession(request.cookies.get(GITHUB_SESSION_COOKIE)?.value);

  return NextResponse.json({
    configured: configuration.configured,
    installationConfigured: configuration.installationConfigured,
    connected: Boolean(session),
    user: session?.user ?? null,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
