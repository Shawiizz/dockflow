import Link from "next/link"
import { ArrowRight, Container, Rocket, Shield, Zap } from "lucide-react"
import { TerminalDemo } from "./_components/terminal-demo"
import { HeroBackground } from "./_components/hero-background"
import './page.css'

export default function Page() {
  return (
    <div className="home-content">
      <HeroBackground /> 
      <div className="content-container">
        <div className="hero-section">
          {/* Headline */}
          <h1 className="hero-headline">
            Deploy with<br />
            <span className="hero-headline-gradient">confidence.</span>
          </h1>

          {/* Subtitle */}
          <p className="hero-subtitle">
            A powerful deployment framework that simplifies Docker deployments 
            to remote servers using Docker Swarm. Fast, reliable and secure.
          </p>

          {/* Buttons */}
          <div className="hero-buttons">
            <Link href="/getting-started" className="hero-button hero-button-primary">
              Get Started
              <ArrowRight style={{ width: 16, height: 16 }} />
            </Link>
            <Link href="/configuration" className="hero-button hero-button-secondary">
              Documentation
            </Link>
          </div>

          {/* Feature Pills */}
          <div className="hero-features">
            <div className="hero-feature-pill">
              <Rocket style={{ width: 16, height: 16 }} />
              <span>Zero-downtime deployments</span>
            </div>
            <div className="hero-feature-pill">
              <Container style={{ width: 16, height: 16 }} />
              <span>Docker Swarm</span>
            </div>
            <div className="hero-feature-pill">
              <Shield style={{ width: 16, height: 16 }} />
              <span>Automatic rollback</span>
            </div>
            <div className="hero-feature-pill">
              <Zap style={{ width: 16, height: 16 }} />
              <span>Health checks</span>
            </div>
          </div>
        </div>

        {/* Terminal Demo */}
        <TerminalDemo />

        {/* Features Section */}
        <div className="features-section">
          <div className="features-grid">
            <div className="feature-card">
              <h3 className="feature-title">Easy Deployment</h3>
              <p className="feature-description">
                Deploy your Docker applications to remote servers with a single command. 
                No complex configuration required.
              </p>
            </div>
            <div className="feature-card">
              <h3 className="feature-title">Zero-Downtime Updates</h3>
              <p className="feature-description">
                Rolling updates ensure your application stays available during deployments 
                with automatic health checks.
              </p>
            </div>
            <div className="feature-card">
              <h3 className="feature-title">Automatic Rollback</h3>
              <p className="feature-description">
                If something goes wrong, Dockflow automatically rolls back to the previous 
                working version.
              </p>
            </div>
            <div className="feature-card">
              <h3 className="feature-title">Built for Speed</h3>
              <p className="feature-description">
                Optimized image transfers and parallel builds make deployments 
                lightning fast.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
