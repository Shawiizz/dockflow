"use client"

import Link from "next/link"
import "./landing.css"
import { Terminal } from "./_components/terminal"
import { HeroBackground } from "./_components/hero-background"

/* ─────────────────────── Page ─────────────────────── */
export default function Page() {
  return (
    <div className="landing-page font-sans text-neutral-50 bg-neutral-950">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden min-h-[min(85vh,900px)] flex items-start">
        <div className="absolute inset-0 z-0 opacity-60 pointer-events-none">
          <HeroBackground />
        </div>
        <div className="relative z-[1] max-w-[900px] mx-auto px-6 pt-[max(10vh,3rem)] pb-16 text-center w-full">
          <div className="inline-block px-3.5 py-[5px] rounded-full border border-neutral-800 text-xs text-neutral-400 mb-6 bg-neutral-900/60">
            Open source &middot; Self-hosted &middot; Free forever
          </div>

          <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold leading-[1.05] m-0 tracking-tight">
            Ship to production
            <br />
            <span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">the simple way.</span>
          </h1>

          <p className="mt-5 text-lg text-neutral-400 max-w-[560px] mx-auto leading-relaxed">
            A CLI that scaffolds, provisions, and deploys Docker applications to your own servers.
            Powered by Docker Swarm and Ansible. No Kubernetes needed.
          </p>

          <div className="flex justify-center gap-3 mt-8 flex-wrap">
            <Link href="/getting-started" className="inline-flex items-center gap-2 px-7 py-3 rounded-[10px] bg-neutral-50 text-neutral-950 text-[15px] font-semibold no-underline transition-all duration-200 hover:bg-white hover:shadow-lg hover:shadow-white/10 hover:scale-[1.02]">
              Get Started
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
            </Link>
            <a href="https://github.com/Shawiizz/dockflow" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-7 py-3 rounded-[10px] border border-neutral-800 text-neutral-50 text-[15px] font-medium no-underline bg-neutral-900/50 transition-all duration-200 hover:bg-neutral-800/80 hover:border-neutral-700">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" /></svg>
              GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Terminal showcase ── */}
      <section className="max-w-[1100px] mx-auto px-6 py-20 grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
        <Terminal />
        <div>
          <h2 className="text-[28px] font-bold m-0 leading-tight">
            Scaffolded. Configured.
            <br />
            <span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">Deployed.</span>
          </h2>
          <p className="text-neutral-400 text-[15px] mt-4 leading-relaxed">
            Dockflow scaffolds your Dockerfile, Compose stack, and server config.
            You customize them, point at your server, and deploy with one command.
          </p>
          <div className="mt-6 rounded-[10px] overflow-hidden bg-gradient-to-br from-[#0b4a98] to-[#1482e9] p-px">
            <div className="bg-neutral-950 rounded-[9px] px-5 py-4 font-mono text-[13px] leading-8">
              <div><span className="text-neutral-500"># scaffold your project</span></div>
              <div><span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">$</span> <span className="text-neutral-50">dockflow init</span></div>
              <div><span className="text-neutral-500"># customize Dockerfile, Compose &amp; servers.yml</span></div>
              <div><span className="text-neutral-500"># provision your server</span></div>
              <div><span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">$</span> <span className="text-neutral-50">dockflow setup</span></div>
              <div><span className="text-neutral-500"># ship it</span></div>
              <div><span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">$</span> <span className="text-neutral-50">dockflow deploy production</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Before / After ── */}
      <section className="max-w-[800px] mx-auto px-6 py-20">
        <h2 className="text-[32px] font-bold text-center m-0">
          Skip the complexity
        </h2>
        <p className="text-neutral-400 text-center text-[15px] mt-3 mb-12">
          Server provisioning, Swarm orchestration, rollbacks — handled for you.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Without */}
          <div className="rounded-xl p-7 border border-neutral-800 bg-[var(--color-card)] transition-all duration-300 hover:border-neutral-700">
            <div className="text-[11px] font-bold uppercase tracking-widest text-neutral-500 mb-5">
              Without Dockflow
            </div>
            {[
              "Install Docker & init Swarm by hand",
              "Manage SSH keys and user accounts",
              "Write bash deploy scripts",
              "Transfer images to servers manually",
              "Roll back manually on failure",
              "SSH into servers to check logs",
            ].map((t) => (
              <div key={t} className="flex items-start gap-2.5 mb-3">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#525252" strokeWidth="2" className="mt-[3px] shrink-0"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                <span className="text-neutral-500 line-through text-sm leading-normal">{t}</span>
              </div>
            ))}
          </div>

          {/* With */}
          <div className="rounded-xl p-7 border border-[#1482e9]/25 bg-[var(--color-card)] shadow-[0_0_40px_rgba(20,130,233,.04)] transition-all duration-300 hover:border-[#1482e9]/40 hover:shadow-[0_0_60px_rgba(20,130,233,.08)]">
            <div className="text-[11px] font-bold uppercase tracking-widest mb-5 bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">
              With Dockflow
            </div>
            {[
              ["dockflow init", "Scaffolds config, Compose & Dockerfile"],
              ["dockflow setup", "Installs Docker, creates user, inits Swarm"],
              ["Connection strings", "Generated automatically after setup"],
              ["dockflow deploy", "Builds, transfers & deploys via SSH"],
              ["Health checks", "Auto rollback on failure"],
              ["Web dashboard", "Logs, services & deploys in your browser"],
            ].map(([cmd, desc]) => (
              <div key={cmd} className="flex items-start gap-2.5 mb-3">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" className="mt-[3px] shrink-0"><path d="M20 6 9 17l-5-5" /></svg>
                <span className="text-sm leading-normal">
                  <code className="text-[#1482e9] font-mono text-[13px] bg-transparent p-0 border-none">{cmd}</code>
                  <span className="text-neutral-500"> — {desc}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features bento ── */}
      <section className="max-w-[1000px] mx-auto px-6 py-20">
        <h2 className="text-[32px] font-bold text-center m-0">
          Everything you need
        </h2>
        <p className="text-neutral-400 text-center text-[15px] mt-3 mb-12">
          From server provisioning to production deploys. One CLI, zero vendor lock-in.
        </p>

        {/* Row 1: 2 large */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <FeatureCard
            icon={<IconTerminal />}
            title="One command deploy"
            desc="dockflow deploy builds your image, transfers it to the server, and updates your Docker Swarm stack — in a single command."
            large
          />
          <FeatureCard
            icon={<IconNoWifi />}
            title="Registry optional"
            desc="By default, images transfer directly via SSH. No registry to set up. Add Docker Hub, GHCR, or a private registry when you need it."
            large
          />
        </div>
        {/* Row 2: 4 small */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <FeatureCard icon={<IconRollback />} title="Auto rollback" desc="Configurable health checks on deploy. Roll back on failure, notify, or ignore." />
          <FeatureCard icon={<IconServer />} title="Single node to cluster" desc="Start on one server. Add workers and scale to multi-node Swarm when ready." />
          <FeatureCard icon={<IconGitBranch />} title="CI/CD workflows" desc="Ships with ready-made GitHub Actions and GitLab CI pipelines. Push a tag, trigger a deploy." />
          <FeatureCard icon={<IconMonitor />} title="Web dashboard" desc="Monitor services, stream logs, and trigger deploys from the built-in web UI." />
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="text-center px-6 py-20 border-t border-neutral-800">
        <h2 className="text-[32px] font-bold m-0">Ready to deploy?</h2>
        <p className="text-neutral-400 text-[15px] mt-2.5">
          Your first deployment in under 5 minutes.
        </p>
        <Link href="/getting-started" className="inline-flex items-center gap-2 mt-7 px-7 py-3 rounded-[10px] bg-neutral-50 text-neutral-950 text-[15px] font-semibold no-underline transition-all duration-200 hover:bg-white hover:shadow-lg hover:shadow-white/10 hover:scale-[1.02]">
          Get Started
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
        </Link>
      </section>
    </div>
  )
}

/* ─────────────────────── Feature card ─────────────────────── */
function FeatureCard({ icon, title, desc, large }: { icon: React.ReactNode; title: string; desc: string; large?: boolean }) {
  return (
    <div className={`rounded-xl border border-neutral-800 bg-[var(--color-card)] transition-all duration-300 ease-out hover:border-neutral-700 hover:bg-neutral-900/80 hover:shadow-lg hover:shadow-[#1482e9]/5 hover:-translate-y-0.5 ${large ? "p-7" : "p-5"}`}>
      <div className={large ? "mb-3.5" : "mb-2.5"}>{icon}</div>
      <div className={`font-semibold ${large ? "text-[17px]" : "text-sm"} mb-1.5`}>{title}</div>
      <p className={`text-neutral-400 leading-relaxed m-0 ${large ? "text-sm" : "text-[13px]"}`}>{desc}</p>
    </div>
  )
}

/* ─────────────────────── Icons ─────────────────────── */
function IconTerminal() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" /></svg>
}
function IconNoWifi() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="2" x2="22" y1="2" y2="22" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /><path d="M5 12.859a10 10 0 0 1 5.17-2.69" /><path d="M13.83 10.17A10 10 0 0 1 19 12.86" /><path d="M2 8.82a15 15 0 0 1 4.17-2.65" /><path d="M17.83 6.17A15 15 0 0 1 22 8.82" /><circle cx="12" cy="20" r="1" /></svg>
}
function IconRollback() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
}
function IconServer() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><circle cx="6" cy="6" r="0" /><circle cx="6" cy="18" r="0" /></svg>
}
function IconGitBranch() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
}
function IconMonitor() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>
}
