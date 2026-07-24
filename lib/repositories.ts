export type TerrainRepository = {
  id: string;
  name: string;
  language: string;
  languageBreakdown?: Record<string, number>;
  color: string;
  created: number;
  commits: number;
  files: number;
  lines: number;
  activity: string;
  px: number;
  py: number;
  labelY: number;
  spread: number;
  relief: number;
  seed: number;
  private?: boolean;
  repositoryUrl?: string;
  installationUrl?: string;
  metricsEstimated?: boolean;
  commitCountAvailable?: boolean;
  fileCountAvailable?: boolean;
  metricsStatus?: "ready" | "permission-required" | "unavailable";
};

export const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] as const;

export type LanguageFilter = string;

export function compactNumber(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: value >= 100_000 ? 0 : 1,
  }).format(value);
}

export function getRepositoryLanguages(repository: TerrainRepository) {
  return Array.from(new Set([repository.language, ...Object.keys(repository.languageBreakdown ?? {})]));
}

export function repositoryHasLanguage(repository: TerrainRepository, language: LanguageFilter) {
  return language === "All" || getRepositoryLanguages(repository).includes(language);
}

export function getLanguageFilters(source: TerrainRepository[]) {
  const counts = new Map<string, number>();

  source.forEach((repository) => {
    getRepositoryLanguages(repository).forEach((language) => {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    });
  });

  return [
    "All",
    ...Array.from(counts.entries())
      .sort(([languageA, countA], [languageB, countB]) => countB - countA || languageA.localeCompare(languageB))
      .map(([language]) => language),
  ];
}

export function languageCount(language: LanguageFilter, source: TerrainRepository[]) {
  if (language === "All") return source.length;
  return source.filter((repository) => repositoryHasLanguage(repository, language)).length;
}

export function languageColor(language: LanguageFilter, source: TerrainRepository[]) {
  if (language === "All") return "#14231b";
  const primaryMatch = source.find((repository) => repository.language === language);
  if (primaryMatch) return primaryMatch.color;

  let hash = 0;
  for (let index = 0; index < language.length; index += 1) {
    hash = (hash * 31 + language.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 62% 56%)`;
}
