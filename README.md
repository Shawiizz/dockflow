<div align="center">

# DevOps Deployment Framework

![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Ansible](https://img.shields.io/badge/Ansible-EE0000?style=for-the-badge&logo=ansible&logoColor=white)
![GitLab CI](https://img.shields.io/badge/GitLab_CI-FC6D26?style=for-the-badge&logo=gitlab&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)

**Automated Docker deployment via CI/CD pipelines**

[![License](https://img.shields.io/badge/License-MIT-00b0ff.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](https://opensource.org/licenses/MIT)
![Version](https://img.shields.io/github/v/tag/Shawiizz/devops-framework?style=for-the-badge&logo=semver&logoColor=white&label=Latest%20Version&color=6F42C1)

</div>

> **BETA VERSION**: Functional and production-ready, but may contain issues. Please report bugs or suggestions.

Deploy Docker applications to servers using GitLab/GitHub CI/CD and Ansible. Supports single or multiple containers from one repository.

## Quick Start

1. [Setup your server](#server-setup) - Use our CLI tool
2. [Configure CI/CD](#cicd-setup) - Copy example files
3. [Deploy](#deployment) - Push a git tag

## Table of Contents

- [How it works](#how-it-works)
- [Server setup](#server-setup)
- [CI/CD setup](#cicd-setup)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Examples](#examples)

## How it works

**Compatibility:**
- GitHub Actions
- GitLab CI

**Features:**
- Multi-environment deployment (production, staging, etc.)
- Multi-host deployment within same environment
- Multi-container deployment from single repository
- Environment isolation using `${ENV}` variable
- SSH keys and secrets management
- Ready-to-use separated CI/CD jobs (build validation + deployment)
- Custom Nginx configurations deployment via templates
- Linux services deployment and management
- Automated script execution on remote servers

**Workflow:**
1. Build Docker images from your Dockerfiles
2. Transfer images directly to target servers
3. Ansible manages the deployment process

**Tags deployment triggers:**
- `X.Y.Z` → deploys to `production`
- `X.Y.Z-[env_name]` → deploys to specified environment

## Server setup

**Prerequisites:**
- Remote server: Debian/Ubuntu
- Local machine: Docker Desktop

**Automated setup (recommended):**

Linux:
```bash
docker run -it --rm \
  -v ~/.ssh:/root/.ssh \
  -v .:/project \
  shawiizz/devops-cli:latest
```

Windows PowerShell:
```powershell
docker run -it --rm `
  -v ${HOME}/.ssh:/root/.ssh `
  -v .:/project `
  shawiizz/devops-cli:latest
```

Manual setup: [See detailed instructions](./MANUAL-REMOTE-SETUP.md)

## CI/CD setup

**1. Copy CI configuration:**
- GitHub: `example/ci/github-ci.yml` → `.github/workflows/`
- GitLab: `example/ci/gitlab-ci.yml` → repository root

⚠️ **GitHub users**: Fork this repository and update the `uses` URL in the workflow file if your repository is in an organization.

**Available CI/CD jobs:**
- **build:** Validates Docker images build on every push
- **deploy:** Deploys to target environment when pushing tags

**2. Create project structure:**
```
deployment/
├── docker/
│   ├── compose-deploy.yml
│   └── Dockerfile.[service_name]
└── env/
    ├── .env.[env_name]
    └── .env.[env_name].[host_name]
```

**3. Add repository secrets:**
- `ANSIBLE_BECOME_PASSWORD`: Ansible user password
- `[ENV_NAME]_SSH_PRIVATE_KEY`: SSH private key for each environment
- For multi-host: `[ENV_NAME]_[HOST_NAME]_SSH_PRIVATE_KEY`

**Notes:**
- All secret names must be UPPERCASE
- GitLab secrets must NOT be marked as protected
- The base `.env.[env_name]` file automatically maps to the `main` host. Don't create additional `.env.[env_name].main` files.

## Deployment

Create and push a git tag:
```bash
git tag 1.0.0              # Deploy to production
git tag 1.0.0-staging      # Deploy to staging
git push origin --tags
```

The framework will:
1. Build your Docker images
2. Deploy to specified environment
3. Handle multiple services automatically

## Configuration

### Environment files

Create `deployment/env/.env.[env_name]` files with required variables:

```bash
HOST=192.168.1.10              # Server IP or CI secret reference
ANSIBLE_USER=ansible           # SSH user (usually 'ansible')
# Add any other variables your app needs
```

You can reference CI secrets:
```bash
HOST=$PRODUCTION_HOST          # Maps to CI secret 'PRODUCTION_HOST'
DB_PASSWORD=$DB_SECRET         # Maps to CI secret 'DB_SECRET'
```
You can also pass `$DB_SECRET` within env part of you docker compose file instead of this way.

### Multi-host deployment

Deploy to multiple servers in the same environment:

```
deployment/env/
├── .env.production            # Main host
├── .env.production.a          # Host A
├── .env.production.b          # Host B
└── .env.production.c          # Host C
```

Host-specific files inherit variables from main file and can override them:

```bash
# .env.production.a
HOST=192.168.1.11
API_PORT=3001                  # Override main config
REDIS_URL=redis://host-a:6379  # Add host-specific variable
```

**SSH keys for each host:**
- Main: `PRODUCTION_SSH_PRIVATE_KEY`
- Host A: `PRODUCTION_A_SSH_PRIVATE_KEY`
- Host B: `PRODUCTION_B_SSH_PRIVATE_KEY`

### Compose file

Your `deployment/docker/compose-deploy.yml` can use environment variables:

```yaml
services:
  app:
    image: my-app-${ENV}:${VERSION}
    environment:
      ENV: ${ENV}
      DB_PASSWORD: ${DB_PASSWORD} # DB_PASSWORD can be defined in .env file or from CI secrets
    ports:
      - "${APP_PORT}:3000"
    networks:
      - network-${ENV}

networks:
  network-${ENV}:
    driver: bridge
```

### Advanced templates

Create custom configurations in `deployment/templates/`:

**Nginx:** `nginx/[name].conf.j2`     
**Services:** `services/[name].service.j2`      
**Scripts:** `scripts/[name].sh.j2`     

All templates support Jinja2 syntax and can access environment variables.    

---

## Examples

**Example files:** Check `example/deployment/` folder for configuration examples.

**Real projects using this framework:**
- [MohistMC Frontend](https://github.com/MohistMC/mohistmc-frontend)
- [MohistMC Backend](https://github.com/MohistMC/mohistmc-backend)
- [Maven Repository](https://github.com/MohistMC/maven)
- [Personal Website](https://github.com/Shawiizz/shawiizz.dev)

---

<div align="center">

## Contributing

Contributions welcome! See [contribution guidelines](./CONTRIBUTE.md).

## License

MIT License

<p>Built with ❤️ for the DevOps community</p>

</div>