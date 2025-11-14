# Contributing Guide

Welcome! Contributions are appreciated. Open an issue or pull request to suggest features or improvements.

## Architecture Overview

Dockflow uses two Docker images:

```mermaid
graph TB
    subgraph "Development & Setup"
        CLI[dockflow-cli:latest<br/>Interactive CLI Tool]
        CLI -->|Setup| Remote[Remote Server]
        CLI -->|Initialize| Local[Local Project Structure]
    end
    
    subgraph "CI/CD Pipeline"
        CI[dockflow-ci:latest<br/>CI/CD Image]
        CI -->|Contains| Tools[Docker + Ansible + NodeJS]
        CI -->|Used by| GitLab[GitLab CI]
        GitHub[GitHub Actions<br/>Uses native ubuntu-latest]
    end
    
    subgraph "Deployment"
        CI -->|Deploys to| Remote
        GitHub -->|Deploys to| Remote
        Remote -->|Runs| App[Your Docker App]
    end
    
    style CLI fill:#2496ED
    style CI fill:#FC6D26
    style GitHub fill:#2088FF
    style Remote fill:#EE0000
```

| Image | Purpose | Contains |
|-------|---------|----------|
| **dockflow-cli** | Machine setup & project initialization | Interactive CLI tool |
| **dockflow-ci** | GitLab CI/CD deployments | Docker, Ansible, NodeJS, deployment scripts |

> **Note:** GitHub Actions uses `ubuntu-latest` which already includes required tools.

---

## Before Contributing

**Run E2E tests** before submitting a PR → See [Developer Guide](./DEVELOPERS.md)

**Use version management scripts** when bumping versions to maintain consistency across all project files (CI configs, examples, Docker images). See [Version Management](#version-management) section.

---

## Building Docker Images

### CLI Image

**Windows users:** Ensure `.sh` files use `LF` (not `CRLF`)

```bash
# Build
docker build -t shawiizz/dockflow-cli:X.Y.Z -f cli/Dockerfile.cli .

# Publish
docker login
docker tag shawiizz/dockflow-cli:X.Y.Z shawiizz/dockflow-cli:latest
docker push shawiizz/dockflow-cli:X.Y.Z
docker push shawiizz/dockflow-cli:latest
```

### CI Image

```bash
# Build
docker build --no-cache -t shawiizz/dockflow-ci:X.Y.Z -f Dockerfile.ci .

# Publish
docker login
docker tag shawiizz/dockflow-ci:X.Y.Z shawiizz/dockflow-ci:latest
docker push shawiizz/dockflow-ci:X.Y.Z
docker push shawiizz/dockflow-ci:latest
```

---

## Version Management

Automated scripts handle version updates across all files.

### Commands

**Framework versions:**
```bash
npm run version:dev        # Add/increment dev version (1.0.33 → 1.0.33-dev1)
npm run version:release    # Create release (1.0.33-dev1 → 1.0.34)
npm run version:downgrade  # Decrement version
```

**CI image versions:**
```bash
npm run ci-image:dev        # Add/increment dev version
npm run ci-image:release    # Create release version
npm run ci-image:downgrade  # Decrement version
```

### What Gets Updated

| Type | Files Updated |
|------|---------------|
| **Framework** | `package.json`, CI/CD configs (`*.yml`), example files |
| **CI Image** | `package.json` (ciImageVersion), Docker image references |

---

## Creating New Releases

```bash
# 1. Update versions
npm run version:release      # Framework version
npm run ci-image:release     # CI image version (if needed)

# 2. Build and publish Docker images (if needed)
# See "Building Docker Images" section above

# 3. Create and push Git tag
git tag -a X.Y.Z -m "Version X.Y.Z"
git push origin X.Y.Z
```

---

## Cleaning Up Dev Tags

To delete all development tags for a specific version:

```bash
node scripts/delete-dev-tags.js 1.0.48
```

This removes all `1.0.48-dev*` tags locally and remotely.

---

## License

Contributions are licensed under the [MIT License](./LICENSE).