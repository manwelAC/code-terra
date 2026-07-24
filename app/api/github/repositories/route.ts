import { NextRequest, NextResponse } from "next/server";
import { GITHUB_SESSION_COOKIE, readGitHubSession } from "@/lib/github-auth";
import type { TerrainRepository } from "@/lib/repositories";

export const dynamic = "force-dynamic";

type GitHubInstallation = {
  id: number;
  html_url?: string;
  permissions?: {
    contents?: "read" | "write";
  };
};
type GitHubInstallationsResponse = { installations: GitHubInstallation[] };
type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  created_at: string;
  pushed_at: string | null;
  updated_at: string;
  language: string | null;
  size: number;
  default_branch: string;
};
type GitHubRepositoriesResponse = { repositories: GitHubRepository[] };
type InstalledGitHubRepository = GitHubRepository & {
  contentsPermissionGranted: boolean;
  installationUrl?: string;
};
type GitHubTreeResponse = { truncated: boolean; tree: Array<{ type: string }> };

const githubHeaders = (accessToken: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${accessToken}`,
  "X-GitHub-Api-Version": "2026-03-10",
});

async function githubRequest(url: string, headers: ReturnType<typeof githubHeaders>) {
  try {
    return await fetch(url, { headers, cache: "no-store" });
  } catch {
    return null;
  }
}

async function readInstallations(headers: ReturnType<typeof githubHeaders>) {
  const installations: GitHubInstallation[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await githubRequest(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      headers,
    );
    if (!response?.ok) return { installations, status: response?.status ?? 502 };
    const pageData = await response.json() as GitHubInstallationsResponse;
    installations.push(...pageData.installations);
    if (pageData.installations.length < 100) break;
  }
  return { installations, status: 200 };
}

async function readInstallationRepositories(
  installation: GitHubInstallation,
  headers: ReturnType<typeof githubHeaders>,
) {
  const repositories: InstalledGitHubRepository[] = [];
  const contentsPermissionGranted = installation.permissions?.contents === "read"
    || installation.permissions?.contents === "write";

  for (let page = 1; page <= 100; page += 1) {
    const response = await githubRequest(
      `https://api.github.com/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
      headers,
    );
    if (!response?.ok) break;
    const pageData = await response.json() as GitHubRepositoriesResponse;
    repositories.push(...pageData.repositories.map(
      (repository): InstalledGitHubRepository => ({
        ...repository,
        contentsPermissionGranted,
        installationUrl: installation.html_url,
      }),
    ));
    if (pageData.repositories.length < 100) break;
  }

  return repositories;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function languageColor(language: string) {
  const known: Record<string, string> = {
    TypeScript: "#35d2e7", JavaScript: "#f0d94e", Python: "#b27aff", "C#": "#8291ff",
    Swift: "#ff7147", Rust: "#f0bd46", Go: "#45d3bc", Java: "#e7865b", Ruby: "#e75d6f",
    PHP: "#8c8edb", Kotlin: "#b77cff", Dart: "#4bb4df", C: "#96a8ba", "C++": "#e675a3",
  };
  if (known[language]) return known[language];
  const hash = stableHash(language);
  const hue = hash % 360;
  const saturation = 58 + (hash % 15);
  const lightness = 58 + ((hash >>> 8) % 10);
  const chroma = (1 - Math.abs(2 * lightness / 100 - 1)) * saturation / 100;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const match = lightness / 100 - chroma / 2;
  const segments = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${segments.map((part) => Math.round((part + match) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function relativeActivity(dateValue: string | null) {
  if (!dateValue) return "No activity";
  const days = Math.max(0, Math.floor((Date.now() - new Date(dateValue).getTime()) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 35) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function commitCountFromHeaders(response: Response, fallbackLength: number) {
  const link = response.headers.get("link");
  if (!link) return fallbackLength;
  const lastLink = link.split(",").find((entry) => entry.includes('rel="last"'));
  if (!lastLink) return fallbackLength;
  const match = lastLink.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : fallbackLength;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>) {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

export async function GET(request: NextRequest) {
  const session = await readGitHubSession(request.cookies.get(GITHUB_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not connected" }, { status: 401 });

  const headers = githubHeaders(session.accessToken);
  const installationData = await readInstallations(headers);
  if (installationData.status !== 200 && !installationData.installations.length) {
    return NextResponse.json(
      { error: "GitHub installations could not be read" },
      { status: installationData.status },
    );
  }
  if (!installationData.installations.length) {
    return NextResponse.json({ repositories: [], needsInstallation: true, total: 0 });
  }

  const repositoryGroups = await Promise.all(
    installationData.installations.map((installation) => readInstallationRepositories(installation, headers)),
  );

  const uniqueRepositories = Array.from(new Map(repositoryGroups.flat().map((repository) => [repository.id, repository])).values())
    .sort((a, b) => new Date(b.pushed_at ?? b.updated_at).getTime() - new Date(a.pushed_at ?? a.updated_at).getTime());

  const metrics = await mapWithConcurrency(uniqueRepositories, 6, async (repository) => {
    const baseUrl = `https://api.github.com/repos/${repository.full_name}`;
    const emptyRepository = repository.size === 0;
    const canReadContents = repository.contentsPermissionGranted;
    const [languagesResponse, treeResponse, commitsResponse] = await Promise.all([
      githubRequest(`${baseUrl}/languages`, headers),
      canReadContents && !emptyRepository
        ? githubRequest(`${baseUrl}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`, headers)
        : Promise.resolve(null),
      canReadContents && !emptyRepository
        ? githubRequest(`${baseUrl}/commits?sha=${encodeURIComponent(repository.default_branch)}&per_page=1`, headers)
        : Promise.resolve(null),
    ]);

    const languageBreakdown = languagesResponse?.ok ? await languagesResponse.json() as Record<string, number> : {};
    const tree = treeResponse?.ok ? await treeResponse.json() as GitHubTreeResponse : null;
    const commits = commitsResponse?.ok ? await commitsResponse.json() as unknown[] : [];
    const fileCountAvailable = emptyRepository || Boolean(treeResponse?.ok && tree && !tree.truncated);
    const commitCountAvailable = emptyRepository || Boolean(commitsResponse?.ok);
    const permissionRejected = [treeResponse?.status, commitsResponse?.status].some(
      (status) => status === 401 || status === 403 || status === 404,
    );
    const metricsStatus: NonNullable<TerrainRepository["metricsStatus"]> = (!canReadContents || permissionRejected) && !emptyRepository
      ? "permission-required"
      : fileCountAvailable && commitCountAvailable
        ? "ready"
        : "unavailable";
    return {
      repository,
      languageBreakdown,
      languageBytes: Object.values(languageBreakdown).reduce((sum, value) => sum + value, 0),
      files: tree?.tree.filter((item) => item.type === "blob").length ?? 0,
      commits: commitsResponse?.ok ? commitCountFromHeaders(commitsResponse, commits.length) : 0,
      fileCountAvailable,
      commitCountAvailable,
      metricsStatus,
    };
  });

  const maxLines = Math.max(1, ...metrics.map((item) => item.languageBytes / 34));
  const maxFiles = Math.max(1, ...metrics.map((item) => item.files));
  const count = Math.max(1, metrics.length);

  const repositories: TerrainRepository[] = metrics.map((item, index) => {
    const primaryLanguage = item.repository.language ?? Object.keys(item.languageBreakdown)[0] ?? "Other";
    const seed = stableHash(item.repository.full_name);
    const angle = index * 2.399963;
    const radial = 0.08 + 0.36 * Math.sqrt((index + 1) / count);
    const estimatedLines = Math.max(1, Math.round(item.languageBytes / 34));
    const lineScale = Math.sqrt(estimatedLines / maxLines);
    const fileScale = Math.sqrt(Math.max(1, item.files) / maxFiles);
    const px = Math.min(0.88, Math.max(0.12, 0.5 + Math.cos(angle) * radial));
    const py = Math.min(0.82, Math.max(0.18, 0.51 + Math.sin(angle) * radial * 0.72));

    return {
      id: String(item.repository.id),
      name: item.repository.name,
      language: primaryLanguage,
      languageBreakdown: item.languageBreakdown,
      color: languageColor(primaryLanguage),
      created: new Date(item.repository.created_at).getFullYear(),
      commits: item.commits,
      files: item.files,
      lines: estimatedLines,
      activity: relativeActivity(item.repository.pushed_at ?? item.repository.updated_at),
      px,
      py,
      labelY: Math.max(0.08, py - 0.17 * (0.65 + lineScale * 0.62)),
      spread: 0.58 + fileScale * 0.7,
      relief: 0.58 + lineScale * 0.7,
      seed: seed % 10_000,
      private: item.repository.private,
      repositoryUrl: item.repository.html_url,
      installationUrl: item.repository.installationUrl,
      metricsEstimated: true,
      fileCountAvailable: item.fileCountAvailable,
      commitCountAvailable: item.commitCountAvailable,
      metricsStatus: item.metricsStatus,
    };
  });

  return NextResponse.json({
    repositories,
    needsInstallation: false,
    total: uniqueRepositories.length,
    contentsPermissionRequired: repositories.some((repository) => repository.metricsStatus === "permission-required"),
  }, { headers: { "Cache-Control": "private, no-store" } });
}
