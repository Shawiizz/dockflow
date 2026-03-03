import Link from "next/link"
import { ArrowRight, Terminal, WifiOff, RotateCcw, Server, GitBranch, Monitor, Github } from "lucide-react"
import { TerminalDemo } from "./_components/terminal-demo"
import { HeroBackground } from "./_components/hero-background"
import './page.css'

export default function Page() {
  return (
    <div className="home-content">
      <HeroBackground />
      <div className="content-container">
        <div className="hero-section">
          <h1 className="hero-headline">
            Deploy with<br />
            <span className="hero-headline-gradient">confidence.</span>
          </h1>

          <p className="hero-subtitle">
            Docker deployments on your own servers — without the complexity of Kubernetes.
            One command to go from code to production.
          </p>

          <div className="hero-buttons">
            <Link href="/getting-started" className="hero-button hero-button-primary">
              Get Started
              <ArrowRight style={{ width: 16, height: 16 }} />
            </Link>
            <a href="https://github.com/Shawiizz/dockflow" target="_blank" rel="noreferrer" className="hero-button hero-button-secondary">
              <Github style={{ width: 16, height: 16 }} />
              GitHub
            </a>
          </div>

          <p className="hero-badge">Open source &middot; Self-hosted &middot; Free forever</p>
        </div>

        {/* Demo + Workflow side by side */}
        <div className="showcase-section">
          <div className="showcase-left">
            <TerminalDemo />
          </div>
          <div className="showcase-right">
            <h2 className="section-title">Three commands. That's it.</h2>
            <div className="workflow-block-wrapper">
              <div className="workflow-block">
                <div className="workflow-line">
                  <span className="workflow-comment"># Setup your server</span>
                </div>
                <div className="workflow-line">
                  <span className="workflow-prompt">$</span>
                  <span className="workflow-cmd">dockflow setup</span>
                </div>
                <div className="workflow-spacer" />
                <div className="workflow-line">
                  <span className="workflow-comment"># Initialize your project</span>
                </div>
                <div className="workflow-line">
                  <span className="workflow-prompt">$</span>
                  <span className="workflow-cmd">dockflow init</span>
                </div>
                <div className="workflow-spacer" />
                <div className="workflow-line">
                  <span className="workflow-comment"># Deploy to production</span>
                </div>
                <div className="workflow-line">
                  <span className="workflow-prompt">$</span>
                  <span className="workflow-cmd">dockflow deploy production</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-section">
          <div className="stat-item">
            <span className="stat-value">20+</span>
            <span className="stat-label">Ansible roles</span>
          </div>
          <div className="stat-divider" />
          <div className="stat-item">
            <span className="stat-value">40+</span>
            <span className="stat-label">CLI commands</span>
          </div>
          <div className="stat-divider" />
          <div className="stat-item">
            <span className="stat-value">0</span>
            <span className="stat-label">Vendor lock-in</span>
          </div>
          <div className="stat-divider" />
          <div className="stat-item">
            <span className="stat-value">0</span>
            <span className="stat-label">Kubernetes required</span>
          </div>
        </div>

        {/* Features */}
        <div className="features-section">
          <h2 className="section-title">Everything you need, nothing you don't</h2>
          <p className="section-subtitle">
            Production-grade deployments with Docker Swarm — no cluster management, no YAML hell, no steep learning curve.
          </p>
          <div className="features-grid">
            <div className="feature-card">
              <Terminal className="feature-icon" />
              <h3 className="feature-title">Single command deploy</h3>
              <p className="feature-description">
                Build, transfer, and deploy in one step. No manual SSH, no Docker commands, no scripts to maintain.
              </p>
            </div>
            <div className="feature-card">
              <WifiOff className="feature-icon" />
              <h3 className="feature-title">No registry required</h3>
              <p className="feature-description">
                Images stream directly to servers via SSH. No Docker Hub, no private registry to manage. Add one when you scale.
              </p>
            </div>
            <div className="feature-card">
              <RotateCcw className="feature-icon" />
              <h3 className="feature-title">Automatic rollback</h3>
              <p className="feature-description">
                Health checks detect failures and roll back to the previous version automatically. No manual intervention needed.
              </p>
            </div>
            <div className="feature-card">
              <Server className="feature-icon" />
              <h3 className="feature-title">One server to cluster</h3>
              <p className="feature-description">
                Start on a single $5 VPS. Scale to a multi-node cluster when ready — same config, same commands.
              </p>
            </div>
            <div className="feature-card">
              <GitBranch className="feature-icon" />
              <h3 className="feature-title">CI/CD ready</h3>
              <p className="feature-description">
                Ships with GitHub Actions and GitLab CI workflows. Push a tag, trigger a deployment. That simple.
              </p>
            </div>
            <div className="feature-card">
              <Monitor className="feature-icon" />
              <h3 className="feature-title">Web dashboard</h3>
              <p className="feature-description">
                Monitor services, stream logs in real-time, and trigger deployments — all from your browser.
              </p>
            </div>
          </div>
        </div>

        {/* Footer CTA */}
        <div className="cta-section">
          <h2 className="cta-title">Ready to deploy?</h2>
          <p className="cta-subtitle">Get your first deployment running in under 5 minutes.</p>
          <Link href="/getting-started" className="hero-button hero-button-primary">
            Get Started
            <ArrowRight style={{ width: 16, height: 16 }} />
          </Link>
        </div>
      </div>
    </div>
  )
}
