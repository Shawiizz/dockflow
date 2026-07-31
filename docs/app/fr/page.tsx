"use client"

import Link from "next/link"
import "../landing.css"
import { Terminal } from "../_components/terminal"
import { HeroBackground } from "../_components/hero-background"

/* ─────────────────────── Page ─────────────────────── */
export default function Page() {
  return (
    <div className="landing-page font-sans text-neutral-900 dark:text-neutral-50 bg-white dark:bg-neutral-950">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden min-h-[min(85vh,900px)] flex items-start">
        <div className="absolute inset-0 z-0 opacity-60 pointer-events-none">
          <HeroBackground />
        </div>
        <div className="relative z-[1] max-w-[900px] mx-auto px-6 pt-[max(6vh,2rem)] pb-16 text-center w-full">
          <div className="inline-block px-3.5 py-[5px] rounded-full border border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 mb-6 bg-neutral-100/60 dark:bg-neutral-900/60">
            Open source &middot; Interface locale &middot; Gratuit pour toujours
          </div>

          <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold leading-[1.05] m-0 tracking-tight">
            Déployez en production
            <br />
            <span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">simplement.</span>
          </h1>

          <p className="mt-5 text-lg text-neutral-500 dark:text-neutral-400 max-w-[560px] mx-auto leading-relaxed">
            Un CLI qui scaffold, provisionne et déploie vos applications Docker sur vos propres serveurs.
            Compatible Docker Swarm et k3s. Aucun vendor lock-in.
          </p>

          <div className="flex justify-center gap-3 mt-8 flex-wrap">
            <Link href="/fr/getting-started" className="inline-flex items-center gap-2 px-7 py-3 rounded-[10px] bg-neutral-900 dark:bg-neutral-50 text-neutral-50 dark:text-neutral-950 text-[15px] font-semibold no-underline transition-all duration-200 hover:bg-neutral-800 dark:hover:bg-white hover:shadow-lg hover:shadow-neutral-900/10 dark:hover:shadow-white/10 hover:scale-[1.02]">
              Commencer
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
            </Link>
            <a href="https://github.com/Shawiizz/dockflow" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-7 py-3 rounded-[10px] border border-neutral-200 dark:border-neutral-800 text-neutral-900 dark:text-neutral-50 text-[15px] font-medium no-underline bg-neutral-100/50 dark:bg-neutral-900/50 transition-all duration-200 hover:bg-neutral-200/80 dark:hover:bg-neutral-800/80 hover:border-neutral-300 dark:hover:border-neutral-700">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" /></svg>
              GitHub
            </a>
          </div>

          <div className="mt-14 max-w-[1000px] mx-auto text-left">
            <Terminal />
          </div>
        </div>
      </section>

      {/* ── Scaffold / deploy flow ── */}
      <section className="max-w-[640px] mx-auto px-6 py-20 text-center">
        <h2 className="text-[32px] font-bold m-0">
          Scaffoldé. Configuré.{" "}
          <span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">Déployé.</span>
        </h2>
        <p className="text-neutral-500 dark:text-neutral-400 text-[15px] mt-3 mb-10 leading-relaxed">
          Dockflow scaffold votre Dockerfile, votre stack Compose et la config serveur.
          Vous les personnalisez, pointez vers votre serveur, et déployez en une commande.
        </p>
        <div className="rounded-[10px] overflow-hidden bg-gradient-to-br from-[#0b4a98] to-[#1482e9] p-px text-left">
          <div className="bg-neutral-950 rounded-[9px] px-5 py-4 font-mono text-[13px] leading-8">
            <div><span className="text-neutral-500"># scaffold votre projet</span></div>
            <div><span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">$</span> <span className="text-neutral-50">dockflow init</span></div>
            <div><span className="text-neutral-500"># personnalisez Dockerfile, Compose &amp; servers.yml</span></div>
            <div><span className="text-neutral-500"># provisionnez votre serveur</span></div>
            <div><span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">$</span> <span className="text-neutral-50">dockflow setup</span></div>
            <div><span className="text-neutral-500"># déployez</span></div>
            <div><span className="bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">$</span> <span className="text-neutral-50">dockflow deploy production</span></div>
          </div>
        </div>
      </section>

      {/* ── Local UI showcase ── */}
      <section className="max-w-[1280px] mx-auto px-6 py-20 text-center">
        <div className="inline-block px-3.5 py-[5px] rounded-full border border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 mb-6 bg-neutral-100/60 dark:bg-neutral-900/60">
          Interface locale &middot; lancée depuis le CLI
        </div>
        <h2 className="text-[32px] font-bold m-0">
          Un dashboard, à une commande de distance
        </h2>
        <p className="text-neutral-500 dark:text-neutral-400 text-[15px] mt-3 mb-10 max-w-[520px] mx-auto leading-relaxed">
          <code className="text-[#1482e9] font-mono text-[13px] bg-transparent p-0 border-none">dockflow ui</code>{" "}
          lance un dashboard web local sur votre machine pour surveiller les services, suivre les logs et déclencher des déploiements — sans installation séparée.
        </p>
        <div className="rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-800 shadow-2xl shadow-black/5">
          <div className="flex items-center px-4 py-2.5 bg-neutral-900 border-b border-neutral-800">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 mr-1.5" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500 mr-1.5" />
            <span className="w-2.5 h-2.5 rounded-full bg-green-500 mr-1.5" />
            <span className="flex-1 text-center text-xs text-neutral-600">Dashboard</span>
          </div>
          <iframe
            src="/ui-demo"
            title="Démo en direct de l'interface Dockflow"
            loading="lazy"
            className="w-full block bg-neutral-950"
            style={{ height: 640, border: "none" }}
          />
        </div>
      </section>

      {/* ── Before / After ── */}
      <section className="max-w-[800px] mx-auto px-6 py-20">
        <h2 className="text-[32px] font-bold text-center m-0">
          Évitez la complexité
        </h2>
        <p className="text-neutral-500 dark:text-neutral-400 text-center text-[15px] mt-3 mb-12">
          Provisioning serveur, orchestration, rollbacks — tout est géré pour vous.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Without */}
          <div className="rounded-xl p-7 border border-neutral-200 dark:border-neutral-800 bg-[var(--color-card)] transition-all duration-300 hover:border-neutral-300 dark:hover:border-neutral-700">
            <div className="text-[11px] font-bold uppercase tracking-widest text-neutral-500 mb-5">
              Sans Dockflow
            </div>
            {[
              "Installer Docker et configurer l'orchestrateur à la main",
              "Gérer les clés SSH et les comptes utilisateurs",
              "Écrire des scripts bash de déploiement",
              "Transférer les images vers les serveurs manuellement",
              "Rollback manuel en cas d'échec",
              "Se connecter en SSH pour consulter les logs",
            ].map((t) => (
              <div key={t} className="flex items-start gap-2.5 mb-3">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a3a3a3" strokeWidth="2" className="mt-[3px] shrink-0"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                <span className="text-neutral-500 line-through text-sm leading-normal">{t}</span>
              </div>
            ))}
          </div>

          {/* With */}
          <div className="rounded-xl p-7 border border-[#1482e9]/25 bg-[var(--color-card)] shadow-[0_0_40px_rgba(20,130,233,.04)] transition-all duration-300 hover:border-[#1482e9]/40 hover:shadow-[0_0_60px_rgba(20,130,233,.08)]">
            <div className="text-[11px] font-bold uppercase tracking-widest mb-5 bg-gradient-to-br from-[#0b4a98] to-[#1482e9] bg-clip-text text-transparent">
              Avec Dockflow
            </div>
            {[
              ["dockflow init", "Scaffold la config, Compose & Dockerfile"],
              ["dockflow setup", "Installe Docker, crée l'utilisateur, configure Swarm ou k3s"],
              ["Chaînes de connexion", "Générées automatiquement après le setup"],
              ["dockflow deploy", "Build, transfère & déploie via SSH"],
              ["Health checks", "Rollback automatique en cas d'échec"],
              ["Dashboard web", "Logs, services & déploiements dans votre navigateur"],
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
          Tout ce dont vous avez besoin
        </h2>
        <p className="text-neutral-500 dark:text-neutral-400 text-center text-[15px] mt-3 mb-12">
          Du provisioning serveur aux déploiements en production. Un seul CLI, zéro vendor lock-in.
        </p>

        {/* Row 1: 2 large */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <FeatureCard
            icon={<IconTerminal />}
            title="Déploiement en une commande"
            desc="dockflow deploy build votre image, la transfère vers le serveur et déploie votre stack via SSH — que vous utilisiez Docker Swarm ou k3s."
            large
          />
          <FeatureCard
            icon={<IconNoWifi />}
            title="Registre optionnel"
            desc="Par défaut, les images transitent directement via SSH. Aucun registre à configurer. Ajoutez Docker Hub, GHCR, ou un registre privé si besoin."
            large
          />
        </div>
        {/* Row 2: 4 small */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <FeatureCard icon={<IconRollback />} title="Rollback automatique" desc="Health checks configurables au déploiement. Rollback, notification, ou ignorance en cas d'échec." />
          <FeatureCard icon={<IconServer />} title="D'un seul nœud au cluster" desc="Démarrez sur un seul serveur. Passez à un cluster Swarm multi-nœuds ou déployez sur k3s quand vous êtes prêt." />
          <FeatureCard icon={<IconGitBranch />} title="Workflows CI/CD" desc="Livré avec des pipelines GitHub Actions et GitLab CI prêts à l'emploi. Poussez un tag, déclenchez un déploiement." />
          <FeatureCard icon={<IconMonitor />} title="Dashboard web" desc="Surveillez les services, suivez les logs et déclenchez des déploiements depuis l'interface web intégrée." />
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="text-center px-6 py-20 border-t border-neutral-200 dark:border-neutral-800">
        <h2 className="text-[32px] font-bold m-0">Prêt à déployer ?</h2>
        <p className="text-neutral-500 dark:text-neutral-400 text-[15px] mt-2.5">
          Votre premier déploiement en moins de 5 minutes.
        </p>
        <Link href="/fr/getting-started" className="inline-flex items-center gap-2 mt-7 px-7 py-3 rounded-[10px] bg-neutral-900 dark:bg-neutral-50 text-neutral-50 dark:text-neutral-950 text-[15px] font-semibold no-underline transition-all duration-200 hover:bg-neutral-800 dark:hover:bg-white hover:shadow-lg hover:shadow-neutral-900/10 dark:hover:shadow-white/10 hover:scale-[1.02]">
          Commencer
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
        </Link>
      </section>
    </div>
  )
}

/* ─────────────────────── Feature card ─────────────────────── */
function FeatureCard({ icon, title, desc, large }: { icon: React.ReactNode; title: string; desc: string; large?: boolean }) {
  return (
    <div className={`rounded-xl border border-neutral-200 dark:border-neutral-800 bg-[var(--color-card)] transition-all duration-300 ease-out hover:border-neutral-300 dark:hover:border-neutral-700 hover:bg-neutral-100/80 dark:hover:bg-neutral-900/80 hover:shadow-lg hover:shadow-[#1482e9]/5 hover:-translate-y-0.5 ${large ? "p-7" : "p-5"}`}>
      <div className={large ? "mb-3.5" : "mb-2.5"}>{icon}</div>
      <div className={`font-semibold ${large ? "text-[17px]" : "text-sm"} mb-1.5`}>{title}</div>
      <p className={`text-neutral-500 dark:text-neutral-400 leading-relaxed m-0 ${large ? "text-sm" : "text-[13px]"}`}>{desc}</p>
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
