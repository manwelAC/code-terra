"use client";

import { useEffect, useState } from "react";
import type { TerrainRepository } from "@/lib/repositories";

type GitHubSessionState = {
  configured: boolean;
  installationConfigured: boolean;
  connected: boolean;
  user: {
    login: string;
    name: string | null;
    profileUrl: string;
  } | null;
};

type OnboardingProps = {
  onComplete: (repositories: TerrainRepository[], total: number) => void;
};

type RepositoryStatus = {
  total: number;
  needsInstallation: boolean;
  repositories: TerrainRepository[];
};

const steps = ["Welcome", "Permissions", "Connect GitHub"];
type StepDirection = "forward" | "backward";

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [stepDirection, setStepDirection] = useState<StepDirection>("forward");
  const [session, setSession] = useState<GitHubSessionState | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [oauthMessage, setOauthMessage] = useState("");
  const [repositoryStatus, setRepositoryStatus] = useState<RepositoryStatus | null>(null);

  const goToStep = (nextStep: number) => {
    if (nextStep === step) return;
    setStepDirection(nextStep > step ? "forward" : "backward");
    setStep(nextStep);
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const onboardingState = params.get("onboarding");
      if (onboardingState) {
        setStepDirection("forward");
        setStep(2);
      }
      if (onboardingState === "denied") setOauthMessage("GitHub access was not granted. Nothing was connected or stored.");
      if (onboardingState === "error") setOauthMessage(params.get("reason") ?? "GitHub could not complete the connection.");
      if (onboardingState === "setup") setOauthMessage("GitHub sign-in is temporarily unavailable. Please try again later.");
    }, 0);

    fetch("/api/github/session", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Session check failed");
        return response.json() as Promise<GitHubSessionState>;
      })
      .then(async (nextSession) => {
        setSession(nextSession);
        if (!nextSession.connected) return;
        const repositoriesResponse = await fetch("/api/github/repositories", { cache: "no-store" });
        if (!repositoriesResponse.ok) {
          setOauthMessage("Your repositories could not be loaded. Review your selected repository access and try again.");
          setRepositoryStatus({ total: 0, needsInstallation: true, repositories: [] });
          return;
        }
        const status = await repositoriesResponse.json() as RepositoryStatus;
        setRepositoryStatus(status);
      })
      .catch(() => setSessionError("The connection service is unavailable. Please try again."));

    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <aside className="onboarding-rail">
        <a className="onboarding-brand" href="#top">Code Terra</a>
        <nav aria-label="Onboarding progress">
          {steps.map((label, index) => (
            <button
              type="button"
              key={label}
              className={`${step === index ? "active" : ""}${step > index ? " complete" : ""}`}
              onClick={() => goToStep(index)}
              aria-current={step === index ? "step" : undefined}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>{label}
            </button>
          ))}
        </nav>
        <div className="onboarding-rail-status">
          <span className="onboarding-lock" aria-hidden="true"/>
          <div><strong>Private by default</strong><small>You choose repository access</small></div>
        </div>
      </aside>

      <main className="onboarding-main">
        <div className="onboarding-coordinate" aria-hidden="true">37.7749° N / 122.4194° W</div>

        {step === 0 && (
          <section key="welcome" className={`onboarding-panel onboarding-step-${stepDirection}`}>
            <p className="eyebrow">ONBOARDING / 01</p>
            <h1 id="onboarding-title">Turn repositories<br/><em>into a landscape.</em></h1>
            <p className="onboarding-lead">Code Terra reads repository signals and translates them into terrain. Before anything connects, you choose what GitHub can share.</p>
            <div className="onboarding-preview" aria-hidden="true">
              <div className="preview-contours"><i/><i/><i/><i/><span>01</span></div>
              <div className="preview-legend"><span>HEIGHT / CODE</span><span>CONTOURS / COMMITS</span><span>GLOW / ACTIVITY</span></div>
            </div>
            <div className="onboarding-actions">
              <button type="button" className="onboarding-primary" onClick={() => goToStep(1)}>Begin setup <span>→</span></button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section key="permissions" className={`onboarding-panel onboarding-step-${stepDirection}`}>
            <p className="eyebrow">PERMISSIONS / 02</p>
            <h1 id="onboarding-title">Clear access.<br/><em>Nothing hidden.</em></h1>
            <p className="onboarding-lead">Code Terra uses a GitHub App so access stays read-only and can be limited to repositories you select.</p>
            <div className="permission-list">
              <article><span>01</span><div><strong>Account identity</strong><p>Confirm your GitHub username and avatar after authorization.</p></div><small>Required</small></article>
              <article><span>02</span><div><strong>Repository metadata</strong><p>Read names, visibility, activity dates, size, and language totals.</p></div><small>Read only</small></article>
              <article><span>03</span><div><strong>Selected repositories</strong><p>You choose which personal or organization repositories the app can see.</p></div><small>Your choice</small></article>
              <article><span>04</span><div><strong>Repository structure</strong><p>Read-only access calculates files and activity. Source contents are never stored.</p></div><small>Read only</small></article>
            </div>
            <div className="privacy-note"><i/><p><strong>Secure processing</strong><br/>Access tokens stay in an encrypted, HTTP-only session and are never exposed to browser scripts.</p></div>
            <div className="onboarding-actions">
              <button type="button" className="onboarding-primary" onClick={() => goToStep(2)}>Review connection <span>→</span></button>
              <button type="button" className="onboarding-secondary" onClick={() => goToStep(0)}>Back</button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section key="connect" className={`onboarding-panel connect-panel onboarding-step-${stepDirection}`}>
            <p className="eyebrow">CONNECT / 03</p>
            <h1 id="onboarding-title">Connect on<br/><em>your terms.</em></h1>
            <p className="onboarding-lead">GitHub handles authorization. Code Terra verifies the response on the server before creating a secure session.</p>

            {sessionError && <div className="onboarding-message error">{sessionError}</div>}
            {oauthMessage && <div className="onboarding-message">{oauthMessage}</div>}

            {!session && !sessionError && <div className="connection-loading"><i/><span>Checking GitHub connection</span></div>}

            {session && !session.configured && <div className="onboarding-message error">GitHub sign-in is temporarily unavailable. Please try again later.</div>}

            {session?.configured && !session.connected && (
              <div className="connection-card">
                <div className="github-mark" aria-hidden="true">GH</div>
                <div><span>GITHUB APP</span><strong>Authorize your account</strong><p>Identity only. Repository access is selected separately after connection.</p></div>
                <small>PKCE secured</small>
              </div>
            )}

            {session?.connected && (
              <div className="connected-card">
                <div className="github-mark connected" aria-hidden="true">{session.user?.login.slice(0, 2).toUpperCase()}</div>
                <div><span>CONNECTED ACCOUNT</span><strong>{session.user?.name || session.user?.login}</strong><p>@{session.user?.login} · {repositoryStatus?.total ? `${repositoryStatus.total} repositories ready` : "Identity verified by GitHub"}</p></div>
                <small>{repositoryStatus?.total ? "Ready" : "Connected"}</small>
              </div>
            )}

            {session?.connected && !repositoryStatus && <div className="connection-loading"><i/><span>Loading selected repositories</span></div>}

            <div className="onboarding-actions">
              {session?.configured && !session.connected && <a className="onboarding-primary" href="/api/github/connect">Continue to GitHub <span>→</span></a>}
              {session?.connected && repositoryStatus && (repositoryStatus.needsInstallation || repositoryStatus.total === 0) && session.installationConfigured && <a className="onboarding-primary" href="/api/github/install">Choose repositories <span>→</span></a>}
              {session?.connected && repositoryStatus && repositoryStatus.total > 0 && <button type="button" className="onboarding-primary" onClick={() => onComplete(repositoryStatus.repositories, repositoryStatus.total)}>Enter Code Terra <span>→</span></button>}
              <button type="button" className="onboarding-back" onClick={() => goToStep(1)}>← Permissions</button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
