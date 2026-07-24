import { NextRequest, NextResponse } from "next/server";
import {
  createCodeChallenge,
  getGitHubConfiguration,
  GITHUB_FLOW_COOKIE,
  githubCookieOptions,
  randomBase64Url,
  sealValue,
  type GitHubOAuthFlow,
} from "@/lib/github-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const configuration = getGitHubConfiguration();
  const origin = request.nextUrl.origin;
  if (!configuration.configured || !configuration.clientId || !configuration.sessionSecret) {
    return NextResponse.redirect(new URL("/?onboarding=setup", origin));
  }

  const state = randomBase64Url();
  const verifier = randomBase64Url();
  const challenge = await createCodeChallenge(verifier);
  const redirectUri = process.env.GITHUB_REDIRECT_URI ?? `${origin}/api/github/callback`;
  const flow: GitHubOAuthFlow = {
    state,
    verifier,
    returnTo: "/?onboarding=connected",
    createdAt: Date.now(),
  };

  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", configuration.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("allow_signup", "true");

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(GITHUB_FLOW_COOKIE, await sealValue(flow, configuration.sessionSecret), githubCookieOptions(10 * 60));
  return response;
}
