export const GITHUB_FLOW_COOKIE = "ct_github_flow";
export const GITHUB_SESSION_COOKIE = "ct_github_session";

export type GitHubUser = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
};

export type GitHubSession = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  user: GitHubUser;
};

export type GitHubOAuthFlow = {
  state: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
};

export function getGitHubConfiguration() {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const sessionSecret = process.env.GITHUB_SESSION_SECRET ?? clientSecret;
  const appSlug = process.env.GITHUB_APP_SLUG;

  return {
    clientId,
    clientSecret,
    sessionSecret,
    appSlug,
    configured: Boolean(clientId && clientSecret && sessionSecret),
    installationConfigured: Boolean(appSlug),
  };
}

export function githubCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
    priority: "high" as const,
  };
}

export function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function createCodeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

async function encryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealValue(value: unknown, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

export async function unsealValue<T>(sealed: string, secret: string): Promise<T> {
  const [version, ivValue, ciphertextValue] = sealed.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue) throw new Error("Invalid sealed value");

  const key = await encryptionKey(secret);
  const iv = Buffer.from(ivValue, "base64url");
  const ciphertext = Buffer.from(ciphertextValue, "base64url");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function readGitHubSession(cookieValue?: string) {
  const configuration = getGitHubConfiguration();
  if (!cookieValue || !configuration.sessionSecret) return null;

  try {
    const session = await unsealValue<GitHubSession>(cookieValue, configuration.sessionSecret);
    if (!session.user?.login || !session.accessToken || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}
