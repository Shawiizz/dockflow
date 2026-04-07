# Contributing Guide

Welcome! Contributions are appreciated. Open an issue or pull request to suggest features or improvements.

## Architecture Overview

Dockflow uses a native CLI binary for all operations:

```mermaid
graph TB
    subgraph "Development & Setup"
        CLI[dockflow CLI<br/>Native Binary]
        CLI -->|Setup| Remote[Remote Server]
        CLI -->|Initialize| Local[Local Project Structure]
    end
    
    subgraph "CI/CD Pipeline"
        GitHub[GitHub Actions]
        GitLab[GitLab CI]
    end
    
    subgraph "Deployment"
        GitHub -->|Deploys to| Remote
        GitLab -->|Deploys to| Remote
        Remote -->|Runs| App[Your Docker App]
    end
    
    style CLI fill:#2496ED
    style GitHub fill:#2088FF
    style Remote fill:#EE0000
```

| Component | Purpose | Description |
|-----------|---------|-------------|
| **dockflow CLI** | Setup, build, deploy & management | Native binary (Linux, macOS, Windows) |

---

## Before Contributing

**Run E2E tests** before submitting a PR → See [Developer Guide](./DEVELOPERS.md)

**Use version management scripts** when bumping versions to maintain consistency across all project files (CI configs, examples, Docker images). See [Version Management](#version-management) section.

---

## Building CLI Binaries

The CLI is built as a native binary using Bun. See the `cli-ts/` directory for the TypeScript source.

### Prerequisites

- [Bun](https://bun.sh) v1.1+ installed

### Build Commands

```bash
cd cli-ts

# Install dependencies
bun install

# Build all platform binaries
bun run build

# Build for a specific platform
bun run build linux-x64
```

### Output

Binaries are generated in `cli-ts/dist/`:

| Binary | Platform |
|--------|----------|
| `dockflow-linux-x64` | Linux (x64) |
| `dockflow-linux-arm64` | Linux (ARM64) |
| `dockflow-windows-x64.exe` | Windows (x64) |
| `dockflow-macos-x64` | macOS (Intel) |
| `dockflow-macos-arm64` | macOS (Apple Silicon) |

### Development

Run the CLI without compilation:

```bash
bun ./cli-ts/src/index.ts --help
bun ./cli-ts/src/index.ts setup interactive
```

#### Testing deploy/build with local Dockflow

Use the dev script to test deployment with your local Dockflow changes. The script automatically:
- Sets `DOCKFLOW_DEV_PATH` to the project root
- Adds `--dev` flag for deploy/build commands

```bash
# From your project directory (e.g., my-app/)
cd /path/to/my-app

# Run dockflow commands using the dev script
bun /path/to/dockflow/cli-ts/scripts/dev.ts deploy production --force
bun /path/to/dockflow/cli-ts/scripts/dev.ts build production
```

**Recommended: Create an alias for convenience**

```bash
# Bash/Linux/macOS - Add to ~/.bashrc or ~/.zshrc
alias dockflow-dev='bun /path/to/dockflow/cli-ts/scripts/dev.ts'
```

```powershell
# PowerShell/Windows - Add to $PROFILE
function dockflow-dev { bun C:\path\to\dockflow\cli-ts\scripts\dev.ts @args }
```

Then use it like the regular CLI:

```bash
dockflow-dev deploy production --force
dockflow-dev build production
dockflow-dev ssh production "docker ps"
```

### Releasing CLI Binaries

GitHub Actions automatically builds and publishes binaries when you push a tag matching `cli/*`:

```bash
# Create a new CLI release
git tag cli/1.0.0
git push origin cli/1.0.0
```

This will:
1. Build binaries for all platforms
2. Create a GitHub Release named "Dockflow CLI v1.0.0"
3. Attach all binaries with installation instructions

Download releases from the [Releases page](https://github.com/Shawiizz/dockflow/releases).

---

## Version Management

Automated scripts handle version updates across all files.

### Commands

**Commands:**
```bash
npm run version:dev        # Add/increment dev version (1.0.33 → 1.0.33-dev1)
npm run version:release    # Create release (1.0.33-dev1 → 1.0.34)
npm run version:downgrade  # Decrement version
```

### What Gets Updated

| Files Updated |
|---------------|
| `package.json`, CI/CD configs (`*.yml`), example files |

---

## Creating New Releases

```bash
# 1. Update version
npm run version:release

# 2. Create and push Git tag
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