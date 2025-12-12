# Dockflow

A deployment framework for Docker Swarm applications.

Dockflow automates the deployment of containerized applications to remote servers using Docker Swarm. It handles image building, transfer, stack deployment, health monitoring, and automatic rollback.

## Documentation

Complete documentation is available at [dockflow.shawiizz.dev](https://dockflow.shawiizz.dev).

## Quick Start

### 1. Set up your server

```bash
curl -fsSL "https://raw.githubusercontent.com/Shawiizz/dockflow/main/cli/cli_wrapper.sh" | bash
```

### 2. Add deployment configuration

Create a `.deployment/` folder in your project with your Docker Compose configuration.

### 3. Configure CI/CD

Add the GitHub Actions or GitLab CI workflow to your repository.

See the [Getting Started guide](https://dockflow.shawiizz.dev/getting-started) for detailed instructions.

## License

MIT
