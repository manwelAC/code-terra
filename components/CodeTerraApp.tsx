"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TerrainCanvas from "@/components/TerrainCanvas";
import Onboarding from "@/components/Onboarding";
import {
  compactNumber,
  getLanguageFilters,
  languageCount,
  languageColor,
  repositoryHasLanguage,
  type LanguageFilter,
  type TerrainRepository,
} from "@/lib/repositories";

type IconName = "atlas" | "repo" | "timeline" | "search" | "refresh" | "export" | "lock" | "arrow" | "key";
type AtlasStatus = "checking" | "disconnected" | "loading" | "ready" | "empty" | "error";

function Icon({ name }: { name: IconName }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "atlas") return <svg {...common}><circle cx="12" cy="12" r="8"/><path d="M4.7 9.7c3.8 2.2 10.8 2.2 14.6 0M4.7 14.3c3.8-2.2 10.8-2.2 14.6 0M12 4c2.4 2.3 3.6 5 3.6 8s-1.2 5.7-3.6 8c-2.4-2.3-3.6-5-3.6-8S9.6 6.3 12 4Z"/></svg>;
  if (name === "repo") return <svg {...common}><path d="M5 4.5h11.5A2.5 2.5 0 0 1 19 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5Z"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5H13"/></svg>;
  if (name === "timeline") return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.8" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="11" cy="18" r="1.8" fill="currentColor" stroke="none"/></svg>;
  if (name === "search") return <svg {...common}><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/></svg>;
  if (name === "refresh") return <svg {...common}><path d="M19 7v5h-5M5 17v-5h5"/><path d="M7.1 8.1A7 7 0 0 1 19 12M5 12a7 7 0 0 0 11.9 3.9"/></svg>;
  if (name === "export") return <svg {...common}><path d="M12 4v11M8 8l4-4 4 4M5 14v5h14v-5"/></svg>;
  if (name === "lock") return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/></svg>;
  if (name === "key") return <svg {...common}><circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20M17 12v3M14.5 12v2"/></svg>;
  return <svg {...common}><path d="M5 12h14M14 7l5 5-5 5"/></svg>;
}

const indexLabel = (index: number) => String(index + 1).padStart(2, "0");

export default function CodeTerraApp() {
  const [repositoryData, setRepositoryData] = useState<TerrainRepository[]>([]);
  const [githubRepositoryTotal, setGitHubRepositoryTotal] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [atlasStatus, setAtlasStatus] = useState<AtlasStatus>("checking");
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [language, setLanguage] = useState<LanguageFilter>("All");
  const [zoom, setZoom] = useState(100);
  const [mapKeyOpen, setMapKeyOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [updatedNow, setUpdatedNow] = useState(false);
  const [toast, setToast] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [entryResolved, setEntryResolved] = useState(false);
  const [terrainHomeActive, setTerrainHomeActive] = useState(true);
  const atlasRef = useRef<HTMLElement>(null);

  const languages = useMemo(() => getLanguageFilters(repositoryData), [repositoryData]);
  const repositoryTotals = useMemo(() => repositoryData.reduce(
    (totals, repository) => ({
      repositories: totals.repositories + 1,
      lines: totals.lines + repository.lines,
      commits: totals.commits + repository.commits,
      files: totals.files + repository.files,
    }),
    { repositories: 0, lines: 0, commits: 0, files: 0 },
  ), [repositoryData]);
  const selectedRepository = repositoryData.find((repository) => repository.id === selectedId) ?? repositoryData[0];
  const selectedIndex = selectedRepository ? repositoryData.findIndex((repository) => repository.id === selectedRepository.id) : -1;
  const visibleCount = repositoryData.filter((repository) => repository.created <= year && repositoryHasLanguage(repository, language)).length;
  const commitCountsComplete = repositoryData.every((repository) => repository.commitCountAvailable === true);
  const fileCountsComplete = repositoryData.every((repository) => repository.fileCountAvailable === true);
  const languageComposition = useMemo(() => {
    if (!selectedRepository) return [];
    const entries = Object.entries(selectedRepository.languageBreakdown ?? {}).sort(([, bytesA], [, bytesB]) => bytesB - bytesA);
    const totalBytes = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
    if (!entries.length || !totalBytes) {
      return [{ name: selectedRepository.language, percentage: 100, color: selectedRepository.color }];
    }
    return entries.slice(0, 5).map(([name, bytes]) => ({
      name,
      percentage: Math.max(1, Math.round((bytes / totalBytes) * 100)),
      color: languageColor(name, repositoryData),
    }));
  }, [repositoryData, selectedRepository]);

  const syncGitHubRepositories = useCallback(async () => {
    setAtlasStatus("loading");
    try {
      const response = await fetch("/api/github/repositories", { cache: "no-store" });
      if (response.status === 401) {
        setRepositoryData([]);
        setSelectedId("");
        setAtlasStatus("disconnected");
        setShowOnboarding(true);
        return false;
      }
      if (!response.ok) throw new Error("Repository request failed");
      const payload = await response.json() as { repositories: TerrainRepository[]; total: number; needsInstallation?: boolean };
      setGitHubRepositoryTotal(payload.total);
      if (!payload.repositories.length) {
        setRepositoryData([]);
        setSelectedId("");
        setAtlasStatus("empty");
        setShowOnboarding(true);
        return false;
      }
      setRepositoryData(payload.repositories);
      setSelectedId(payload.repositories[0].id);
      setLanguage("All");
      setUpdatedNow(true);
      setAtlasStatus("ready");
      return true;
    } catch {
      setAtlasStatus("error");
      return false;
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    const loadGitHubAtlas = async () => {
      const forcedState = new URLSearchParams(window.location.search).has("onboarding");
      try {
        const response = await fetch("/api/github/session", { cache: "no-store" });
        const session = response.ok ? await response.json() as { connected: boolean } : null;
        if (cancelled) return;
        if (!session?.connected) {
          setAtlasStatus("disconnected");
          setShowOnboarding(true);
          setEntryResolved(true);
          return;
        }
        if (forcedState) {
          setAtlasStatus("loading");
          setShowOnboarding(true);
          setEntryResolved(true);
          return;
        }
        const synced = await syncGitHubRepositories();
        if (cancelled) return;
        const onboardingComplete = window.localStorage.getItem("code-terra:onboarding") === "complete";
        setShowOnboarding(!synced || !onboardingComplete);
        setEntryResolved(true);
      } catch {
        if (!cancelled) {
          setAtlasStatus("error");
          setShowOnboarding(true);
          setEntryResolved(true);
        }
      }
    };
    void loadGitHubAtlas();
    return () => {
      cancelled = true;
    };
  }, [syncGitHubRepositories]);

  const completeOnboarding = (repositories: TerrainRepository[], total: number) => {
    if (!repositories.length) return;
    setRepositoryData(repositories);
    setGitHubRepositoryTotal(total);
    setSelectedId(repositories[0].id);
    setLanguage("All");
    setUpdatedNow(true);
    setAtlasStatus("ready");
    window.localStorage.setItem("code-terra:onboarding", "complete");
    window.history.replaceState({}, "", window.location.pathname);
    setEntryResolved(true);
    setTerrainHomeActive(true);
    setShowOnboarding(false);
  };

  const showToast = (message: string) => {
    setToast("");
    window.setTimeout(() => setToast(message), 20);
  };

  const handleRescan = () => {
    if (isScanning) return;
    setIsScanning(true);
    window.setTimeout(() => {
      setIsScanning(false);
      setUpdatedNow(true);
      void syncGitHubRepositories().then((synced) => {
        showToast(synced ? "GitHub repository snapshot refreshed." : "GitHub repositories could not be refreshed.");
      });
    }, 1100);
  };

  const handleExport = () => {
    const payload = {
      format: "code-terra-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      source: "github",
      repositories: repositoryData.map(({ id, name, language: repoLanguage, created, commits, files, lines, activity }) => ({ id, name, language: repoLanguage, created, commits, files, lines, activity })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "code-terra-world.json";
    link.click();
    URL.revokeObjectURL(url);
    showToast("Terrain data exported as JSON.");
  };

  const selectFromIndex = (id: string) => {
    setSelectedId(id);
    atlasRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!selectedRepository || !entryResolved) {
    const gateMessage = atlasStatus === "loading" || atlasStatus === "checking"
      ? "Reading your GitHub repositories"
      : atlasStatus === "empty"
        ? "Choose at least one repository to build your atlas"
        : atlasStatus === "error"
          ? "GitHub data could not be loaded"
          : "Connect GitHub to build your atlas";

    return (
      <div className="app-shell live-atlas-gate">
        <a href="#top" className="brand-name">Code Terra</a>
        <div className="live-atlas-gate-message" role="status">
          <i aria-hidden="true"/>
          <p>LIVE ATLAS</p>
          <strong>{gateMessage}</strong>
        </div>
        {showOnboarding && <Onboarding onComplete={completeOnboarding}/>}
      </div>
    );
  }

  if (terrainHomeActive && !showOnboarding) {
    return (
      <div className="terrain-home-shell">
        <TerrainCanvas
          key="terrain-home"
          repositories={repositoryData}
          selectedId={selectedId}
          year={year}
          language={language}
          zoom={zoom}
          isImmersive
          mapKeyOpen={mapKeyOpen}
          onSelect={setSelectedId}
          onYearChange={setYear}
          onZoomChange={setZoom}
          onLanguageChange={setLanguage}
          onImmersiveChange={setTerrainHomeActive}
          onToggleMapKey={() => setMapKeyOpen((open) => !open)}
          onCloseMapKey={() => setMapKeyOpen(false)}
        />
        {toast && <div className="toast" role="status" aria-live="polite"><i/>{toast}</div>}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <div className="brand-block">
          <a href="#top" className="brand-name">Code Terra</a>
        </div>

        <nav className="rail-nav" aria-label="Primary navigation">
          <span className="rail-label">Explore</span>
          <a className="active" href="#atlas"><Icon name="atlas"/><span>Atlas</span><kbd>1</kbd></a>
          <a href="#timeline"><Icon name="timeline"/><span>Timeline</span><kbd>2</kbd></a>
        </nav>

        <nav className="language-nav" aria-label="Language filters">
          <span className="rail-label">Languages</span>
          {languages.map((item) => (
            <button type="button" key={item} className={language === item ? "active" : ""} onClick={() => setLanguage(item)}>
              <span className="language-dot" style={{ background: languageColor(item, repositoryData) }}/><span>{item}</span><small>{languageCount(item, repositoryData)}</small>
            </button>
          ))}
        </nav>

        <div className="rail-bottom">
          <div className="rail-tools">
            <button type="button" onClick={() => showToast("Search will filter repositories once GitHub is connected.")}>
              <span>Search atlas</span><kbd>⌘</kbd><kbd>K</kbd>
            </button>
            <button type="button" onClick={handleRescan} disabled={isScanning}>
              <span>{isScanning ? "Scanning repositories" : "Refresh repository data"}</span><kbd>R</kbd>
            </button>
          </div>

          <div className="repository-presence">
            <div className="presence-dots" aria-hidden="true">
              {repositoryData.slice(0, 4).map((repository) => <i key={repository.id} style={{ background: repository.color }}/>) }
              {repositoryData.length > 4 && <span>+{repositoryData.length - 4}</span>}
            </div>
            <p><strong>{repositoryData.length}</strong> repositories mapped now</p>
          </div>

          <div className="local-status"><Icon name="lock"/><div><strong>Read-only GitHub access</strong><span>No source code stored</span></div></div>

          <div className="rail-quick-actions" aria-label="Atlas quick actions">
            <button type="button" aria-label="Rescan repositories" onClick={handleRescan}><Icon name="refresh"/></button>
            <button type="button" aria-label="Export terrain data" onClick={handleExport}><Icon name="export"/></button>
          </div>

          <p className="rail-note">Private by design. You choose which repositories Code Terra can map.</p>
          <button type="button" className="connect-button" onClick={() => setShowOnboarding(true)}><Icon name="repo"/>Manage GitHub</button>
        </div>
      </aside>

      <div className="workspace" id="top">
        <header className="workspace-bar">
          <a href="#top" className="breadcrumb">CODE TERRA <span>/</span> ATLAS_01</a>
          <div className="workspace-actions">
            <button type="button" onClick={() => showToast("Search will filter repositories once GitHub is connected.")}><Icon name="search"/><span>Search</span><kbd>⌘K</kbd></button>
            <button type="button" onClick={handleRescan} disabled={isScanning} className={isScanning ? "is-scanning" : ""}><Icon name="refresh"/><span>{isScanning ? "Scanning" : "Rescan"}</span></button>
            <button type="button" onClick={handleExport}><Icon name="export"/><span>Export</span></button>
          </div>
        </header>

        <main>
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-heading">
              <div><p className="eyebrow">GITHUB REPOSITORIES / {updatedNow ? "UPDATED JUST NOW" : "READY TO EXPLORE"}</p><h1 id="hero-title">Your code,<br/><em>rendered as terrain.</em></h1></div>
              <p className="hero-note">A private atlas of the systems you build—mapped by size, activity, and time.</p>
            </div>
            <dl className="aggregate-grid">
              <div><dt>Repositories</dt><dd>{githubRepositoryTotal}</dd><span>01</span></div>
              <div><dt>Estimated LOC</dt><dd>{compactNumber(repositoryTotals.lines)}</dd><span>02</span></div>
              <div><dt>Commits</dt><dd>{commitCountsComplete ? repositoryTotals.commits : "—"}</dd><span>03</span></div>
              <div><dt>Files</dt><dd>{fileCountsComplete ? repositoryTotals.files.toLocaleString("en") : "—"}</dd><span>04</span></div>
            </dl>
          </section>

          <section className="atlas-section" id="atlas" ref={atlasRef} aria-labelledby="atlas-title">
            <div className="atlas-viewbar">
              <div className="view-status"><span className="live-dot"/><strong id="atlas-title">Terrain view</strong><small>{visibleCount} visible {visibleCount === 1 ? "repository" : "repositories"}</small></div>
              <div className="view-controls">
                {language !== "All" && <button type="button" className="active-filter" onClick={() => setLanguage("All")}><span style={{ background: languageColor(language, repositoryData) }}/>{language}<b>×</b></button>}
                <button type="button" onClick={() => setMapKeyOpen((open) => !open)}><Icon name="key"/>Map key</button>
              </div>
            </div>

            <div className="atlas-layout">
              <TerrainCanvas key="terrain-overview" repositories={repositoryData} selectedId={selectedId} year={year} language={language} zoom={zoom} isImmersive={false} mapKeyOpen={mapKeyOpen} onSelect={setSelectedId} onYearChange={setYear} onZoomChange={setZoom} onLanguageChange={setLanguage} onImmersiveChange={setTerrainHomeActive} onToggleMapKey={() => setMapKeyOpen((open) => !open)} onCloseMapKey={() => setMapKeyOpen(false)}/>
              <aside key={selectedRepository.id} className="inspector" aria-live="polite">
                <div className="inspector-topline"><span>SELECTED REPOSITORY</span><span>{selectedIndex + 1}/{repositoryData.length}</span></div>
                <div className="repository-flags"><span><i style={{ background: selectedRepository.color }}/>{selectedRepository.language}</span><span><Icon name="lock"/>{selectedRepository.private ? "Private" : "Public"}</span></div>
                <div className="repository-title"><p>{indexLabel(selectedIndex)} / REPOSITORY</p><h2>{selectedRepository.name}</h2><span>Created {selectedRepository.created} · Active {selectedRepository.activity}</span></div>
                <div className="primary-metric"><span>{selectedRepository.metricsEstimated ? "ESTIMATED LINES OF CODE" : "LINES OF CODE"}</span><strong>{selectedRepository.metricsEstimated ? "~" : ""}{selectedRepository.lines.toLocaleString("en")}</strong><small>{selectedRepository.metricsEstimated ? "Estimated from GitHub language bytes" : "Controls terrain height"}</small></div>
                <dl className="secondary-metrics">
                  <div><dt>Commits</dt><dd>{selectedRepository.commitCountAvailable ? selectedRepository.commits : "—"}</dd>{!selectedRepository.commitCountAvailable && <small>Access needed</small>}</div>
                  <div><dt>Files</dt><dd>{selectedRepository.fileCountAvailable ? selectedRepository.files.toLocaleString("en") : "—"}</dd>{!selectedRepository.fileCountAvailable && <small>Access needed</small>}</div>
                </dl>
                {selectedRepository.metricsStatus !== "ready" && (
                  <div className="metrics-access-note">
                    <strong>{selectedRepository.metricsStatus === "permission-required" ? "Contents access required" : "Metrics temporarily unavailable"}</strong>
                    <p>{selectedRepository.metricsStatus === "permission-required" ? "GitHub is sharing metadata, but this installation has not approved read-only Contents access." : "GitHub could not return this repository’s commit or file-tree metrics."}</p>
                    {selectedRepository.metricsStatus === "permission-required" && (
                      <div className="metrics-access-actions">
                        <a href={selectedRepository.installationUrl ?? "https://github.com/settings/installations"} target="_blank" rel="noreferrer">Review access <Icon name="arrow"/></a>
                        <a href="/api/github/connect">Reconnect <Icon name="refresh"/></a>
                      </div>
                    )}
                  </div>
                )}
                <div className="activity-block">
                  <div><span>LANGUAGE PROFILE</span><strong>{languageComposition.length} detected</strong></div>
                  <div className="language-composition" aria-label="Repository language distribution">
                    {languageComposition.map((item) => <i key={item.name} title={`${item.name}: ${item.percentage}%`} style={{ width: `${item.percentage}%`, background: item.color }}/>)}
                  </div>
                  <div className="language-composition-key">{languageComposition.slice(0, 3).map((item) => <span key={item.name}><i style={{ background: item.color }}/>{item.name} {item.percentage}%</span>)}</div>
                </div>
                <div className="inspector-action"><button type="button" onClick={() => selectedRepository.repositoryUrl && window.open(selectedRepository.repositoryUrl, "_blank", "noopener,noreferrer")}>Open repository <Icon name="arrow"/></button><span><Icon name="lock"/>Read-only access</span></div>
              </aside>
            </div>
          </section>

          <section className="repository-index" id="repositories" aria-labelledby="repository-heading">
            <div className="index-heading"><div><p className="eyebrow">INDEX / 02</p><h2 id="repository-heading">Repositories</h2></div><p>Select a row to locate it<br/>on the terrain.</p></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Language</th><th>Created</th><th>Est. LOC</th><th>Commits</th><th>Files</th><th>Updated</th></tr></thead>
                <tbody>{repositoryData.map((repository, index) => (
                  <tr key={repository.id} className={repository.id === selectedId ? "is-selected" : ""} onClick={() => selectFromIndex(repository.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectFromIndex(repository.id); }} tabIndex={0}>
                    <td><span className="row-index">{indexLabel(index)}</span><strong>{repository.name}</strong>{repository.id === selectedId && <small>Selected</small>}</td>
                    <td><i style={{ background: repository.color }}/>{repository.language}</td><td>{repository.created}</td><td>{repository.metricsEstimated ? "~" : ""}{compactNumber(repository.lines)}</td><td>{repository.commits}</td><td>{repository.files.toLocaleString("en")}</td><td>{repository.activity}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </main>

        <footer><span>CODE TERRA / PRIVATE REPOSITORY ATLAS</span><span>ENCRYPTED SESSION · SELECTED REPOS · READ ONLY</span></footer>
      </div>

      {toast && <div className="toast" role="status" aria-live="polite"><i/>{toast}</div>}
      {showOnboarding && <Onboarding onComplete={completeOnboarding}/>} 
    </div>
  );
}
