import { NextRequest, NextResponse } from "next/server";
import {
  getGitHubConfiguration,
  GITHUB_FLOW_COOKIE,
  GITHUB_SESSION_COOKIE,
  githubCookieOptions,
  sealValue,
  unsealValue,
  type GitHubOAuthFlow,
  type GitHubSession,
} from "@/lib/github-auth";

export const dynamic = "force-dynamic";

type GitHubTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

type GitHubUserResponse = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
};

function onboardingRedirect(origin: string, state: string, reason?: string) {
  const url = new URL(`/?onboarding=${state}`, origin);
  if (reason) url.searchParams.set("reason", reason.slice(0, 120));
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const configuration = getGitHubConfiguration();
  const origin = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  const providerError = request.nextUrl.searchParams.get("error");

  if (providerError) return onboardingRedirect(origin, "denied", providerError);
  if (!configuration.configured || !configuration.clientId || !configuration.clientSecret || !configuration.sessionSecret) {
    return onboardingRedirect(origin, "setup");
  }

  const sealedFlow = request.cookies.get(GITHUB_FLOW_COOKIE)?.value;
  if (!code || !returnedState || !sealedFlow) return onboardingRedirect(origin, "error", "Missing OAuth state");

  let flow: GitHubOAuthFlow;
  try {
    flow = await unsealValue<GitHubOAuthFlow>(sealedFlow, configuration.sessionSecret);
  } catch {
    return onboardingRedirect(origin, "error", "Invalid OAuth state");
  }

  if (flow.state !== returnedState || Date.now() - flow.createdAt > 10 * 60 * 1000) {
    return onboardingRedirect(origin, "error", "Expired OAuth state");
  }

  const redirectUri = process.env.GITHUB_REDIRECT_URI ?? `${origin}/api/github/callback`;
  let tokenResponse: Response;
  let token: GitHubTokenResponse;
  try {
    tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: flow.verifier,
      }),
      cache: "no-store",
    });
    token = await tokenResponse.json() as GitHubTokenResponse;
  } catch {
    return onboardingRedirect(origin, "error", "GitHub authorization could not be reached. Please try again.");
  }
  if (!tokenResponse.ok || !token.access_token) {
    return onboardingRedirect(origin, "error", token.error_description ?? token.error ?? "Token exchange failed");
  }

  let userResponse: Response;
  try {
    userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.access_token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
      cache: "no-store",
    });
  } catch {
    return onboardingRedirect(origin, "error", "GitHub profile verification could not be reached. Please try again.");
  }
  if (!userResponse.ok) return onboardingRedirect(origin, "error", "GitHub identity check failed");
  const user = await userResponse.json() as GitHubUserResponse;

  const expiresIn = token.expires_in ?? 8 * 60 * 60;
  const session: GitHubSession = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    tokenType: token.token_type ?? "bearer",
    expiresAt: Date.now() + expiresIn * 1000,
    refreshTokenExpiresAt: token.refresh_token_expires_in ? Date.now() + token.refresh_token_expires_in * 1000 : undefined,
    user: {
      id: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      profileUrl: user.html_url,
    },
  };

  const response = NextResponse.redirect(new URL(flow.returnTo, origin));
  response.cookies.set(GITHUB_SESSION_COOKIE, await sealValue(session, configuration.sessionSecret), githubCookieOptions(expiresIn));
  response.cookies.set(GITHUB_FLOW_COOKIE, "", { ...githubCookieOptions(0), maxAge: 0 });
  return response;
}
